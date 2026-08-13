// ==UserScript==
// @name         YouTube Shadow Comment / extended
// @namespace    http://spazma.net/
// @version      20260812-14.1
// @description  Highlights comments from configured handles and indicates visibility. Uses Shadow DOM UI, MutationObserver + IntersectionObserver to avoid aggressive polling. CSP-safe, resilient
// @author       Robert Wesner - shadowban detect, rest: Spazma
// @homepageURL  http://robert.wesner.io/ , https://spazma.net
// @license      MIT
// @match        https://*.youtube.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // ---------- CONFIG ----------
  const DEFAULT_TARGETS = ['@your_example_handle'];
  const DEBUG = false;
  const CACHE_TTL = 15 * 60 * 1000;
  const MAX_CONCURRENT = 3;
  const STORAGE_KEY = 'ysc_targets_v1';

  function dbg(...a){ if (DEBUG) console.log('[YSC]', ...a); }

  // --- Inject page highlight styles (so highlights affect YouTube DOM, not Shadow)
  (function injectPageHighlightStyles(){
    try {
      if (document.getElementById('ysc-page-styles')) return;
      const s = document.createElement('style'); s.id = 'ysc-page-styles';
      s.textContent = `
        ytd-comment-thread-renderer[data-ysc-invisible-comment="checking"] { background-color: rgba(100,100,100,0.12) !important; }
        ytd-comment-thread-renderer[data-ysc-invisible-comment="banned"] { background-color: rgba(255,0,0,0.12) !important; }
        ytd-comment-thread-renderer[data-ysc-invisible-comment="valid"] { background-color: rgba(3,255,36,0.12) !important; }
        ytd-comment-thread-renderer[data-ysc-invisible-comment="blocked"] { outline: 2px dashed orange !important; }
        ytd-comment-thread-renderer[data-ysc-invisible-comment] ytd-comment-renderer,
        ytd-comment-thread-renderer[data-ysc-invisible-comment] #content { background-clip: padding-box !important; }
      `;
      document.head.appendChild(s);
    } catch (e) { console.warn('YSC: injectPageHighlightStyles failed', e); }
  })();

  // ---------- Storage / Targets ----------
  function loadTargets(){ try { const raw = localStorage.getItem(STORAGE_KEY); if(!raw) return DEFAULT_TARGETS.slice(); const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : DEFAULT_TARGETS.slice(); } catch(e) { return DEFAULT_TARGETS.slice(); } }
  function saveTargets(list){ try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch(e) { console.warn('YSC save', e); } }
  let targetsList = loadTargets();
  let normalizedTargets = new Set();
  function updateNormalizedTargetsFromList(list){
    normalizedTargets = new Set(list.map(t=> (t||'').toString().trim().replace(/^@+/,'').toLowerCase()).filter(Boolean));
    dbg('normalizedTargets', Array.from(normalizedTargets));
  }
  updateNormalizedTargetsFromList(targetsList);

  // ---------- Cache & Queue ----------
  const cache = new Map();
  function getCache(k){ const e = cache.get(k); if(!e) return null; if(Date.now()-e.ts > CACHE_TTL){ cache.delete(k); return null; } return e.state; }
  function setCache(k,s){ cache.set(k,{ state: s, ts: Date.now() }); }
  let concurrent = 0; const q = [];
  function enqueueTask(t){ q.push(t); processQueue(); }
  function processQueue(){ if(concurrent >= MAX_CONCURRENT) return; const task = q.shift(); if(!task) return; concurrent++; task().finally(()=>{ concurrent--; processQueue(); }); }

  // ---------- Matching helpers (STRICT) ----------
  function normalizeHref(h){ if(!h) return ''; try { const u = new URL(h, location.origin); let p = u.pathname.replace(/\/+$/,''); if(p.startsWith('/')) p = p.slice(1); return p.toLowerCase(); } catch(e) { let p = (h||'').split('?')[0].replace(/\/+$/,''); if(p.startsWith('/')) p = p.slice(1); return p.toLowerCase(); } }
  function lastSegment(path){ if(!path) return ''; const ps = path.split('/'); return ps[ps.length-1] || ''; }
  function isRecognizedAuthorHref(hrefNorm){ if(!hrefNorm) return false; return hrefNorm.startsWith('@') || hrefNorm.startsWith('channel/') || hrefNorm.startsWith('user/') || hrefNorm.startsWith('c/'); }

  function isTargetAuthorFromAnchor(authorAnchor){
    // STRICT matching: rely only on href patterns
    if(!authorAnchor) return false;
    const href = (authorAnchor.getAttribute('href') || '').trim();
    if(!href) return false;
    const nh = normalizeHref(href);
    if(!nh) return false;
    // @handle or path containing segment '@handle'
    if(nh.startsWith('@')){
      const handle = nh.replace(/^@+/,'').toLowerCase();
      return normalizedTargets.has(handle);
    }
    const segs = nh.split('/');
    for(const s of segs){
      if(s.startsWith('@')){
        const h = s.replace(/^@+/,'').toLowerCase();
        if(normalizedTargets.has(h)) return true;
      }
    }
    // channel/UC...
    if(nh.startsWith('channel/')){
      const id = segs[segs.length-1].toLowerCase();
      return normalizedTargets.has(id);
    }
    // user/ or c/
    if(nh.startsWith('user/') || nh.startsWith('c/')){
      const name = segs[segs.length-1].toLowerCase();
      return normalizedTargets.has(name);
    }
    return false;
  }

  // ---------- Shadow DOM UI + Focus Trap ----------
  let shadowHost = null, shadowRoot = null, btn = null, panel = null, banner = null, overlay = null;
  let panelOpen = false;
  let prevActive = null;

  function createShadowUI(){
    if(document.getElementById('ysc-shadow-host')) return;
    try {
      shadowHost = document.createElement('div'); shadowHost.id = 'ysc-shadow-host'; shadowHost.style.all = 'initial';
      (document.documentElement || document.body).appendChild(shadowHost);
      shadowRoot = shadowHost.attachShadow({mode:'open'});

      const s = document.createElement('style');
      s.textContent = `
        :host{all:initial}
        #ysc-container{position:fixed;top:8px;right:8px;z-index:2147483647;font-family:Arial, sans-serif}
        #ysc-btn{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.5);border:2px solid rgba(255,255,255,0.95);user-select:none;background:#ffeb3b;color:#111;font-size:12px}
        #ysc-panel{margin-top:8px;width:360px;background:rgba(18,18,18,0.98);color:#eee;border-radius:8px;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,0.6);display:none;font-size:13px}
        #ysc-panel textarea{width:100%;height:140px;background:#111;color:#fff;border:1px solid #333;border-radius:6px;padding:8px;resize:vertical}
        #ysc-overlay{position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,0.0);z-index:2147483646;display:none}
        #ysc-banner{position:fixed;left:12px;bottom:12px;background:rgba(20,20,20,0.95);color:#fff;padding:10px;border-radius:8px;min-width:260px;display:none}
        button.ysc-btn { padding:6px 8px; border-radius:6px; cursor:pointer; background:#2b2b2b; color:#fff; border:1px solid #444; }
        button.ysc-btn.secondary { background: transparent; color:#ccc; border:1px solid #444; }
      `;
      shadowRoot.appendChild(s);

      overlay = document.createElement('div'); overlay.id = 'ysc-overlay'; shadowRoot.appendChild(overlay);

      const container = document.createElement('div'); container.id='ysc-container';
      btn = document.createElement('div'); btn.id='ysc-btn'; btn.textContent = '⚙'; btn.tabIndex = 0; btn.setAttribute('role','button');
      panel = document.createElement('div'); panel.id='ysc-panel';
      const h4 = document.createElement('h4'); h4.textContent="CONFIGURATION ⚙ "; panel.appendChild(h4);
      const info = document.createElement('div'); info.style.color='#aaa'; info.style.fontSize='12px'; info.style.marginBottom='4px';
      info.textContent = 'Shadowban Checker / Highlighting your own comments';
      panel.appendChild(info);
      const ta = document.createElement('textarea'); ta.id = 'ysc-targets-ta'; ta.placeholder = '@handle1\n@handle2'; panel.appendChild(ta);
      const muted = document.createElement('div'); muted.style.color='#bbb'; muted.style.fontSize='12px'; muted.style.marginTop='6px'; muted.textContent='One @handle per line'; panel.appendChild(muted);
      const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px'; actions.style.marginTop='10px'; actions.style.justifyContent='flex-end';
      const btnRestore = document.createElement('button'); btnRestore.className='ysc-btn secondary'; btnRestore.textContent='DEFAULT';
      const btnRetry = document.createElement('button'); btnRetry.className='ysc-btn'; btnRetry.textContent='RETRY CHECK';
      const btnClear = document.createElement('button'); btnClear.className='ysc-btn secondary'; btnClear.textContent='CLEAR CACHE';
      const btnCancel = document.createElement('button'); btnCancel.className='ysc-btn secondary'; btnCancel.textContent='CANCEL / BACK';
      const btnSave = document.createElement('button'); btnSave.className='ysc-btn'; btnSave.textContent='SAVE';
      actions.appendChild(btnRestore); actions.appendChild(btnRetry); actions.appendChild(btnClear); actions.appendChild(btnCancel); actions.appendChild(btnSave);
      panel.appendChild(actions);
      container.appendChild(btn); container.appendChild(panel);
      shadowRoot.appendChild(container);

      banner = document.createElement('div'); banner.id='ysc-banner'; const bh=document.createElement('h4'); bh.textContent='YouTube Shadow Comment'; const bp=document.createElement('p'); bp.id='ysc-banner-msg'; bp.textContent='OK — no problems :)'; banner.appendChild(bh); banner.appendChild(bp); shadowRoot.appendChild(banner);

      // Focus-trap behavior and improved key capture (uses composedPath)
      function openPanel(){
        if(!panel || !overlay) return;
        prevActive = document.activeElement;
        panel.style.display = 'block';
        overlay.style.display = 'block';
        panelOpen = true;
        const taEl = shadowRoot.querySelector('#ysc-targets-ta');
        if(taEl) taEl.value = targetsList.join('\n');
        setTimeout(()=>{ taEl && taEl.focus(); }, 50);
        window.addEventListener('keydown', panelKeyCapture, true);
      }
      function closePanel(){
        if(!panel || !overlay) return;
        panel.style.display = 'none';
        overlay.style.display = 'none';
        panelOpen = false;
        window.removeEventListener('keydown', panelKeyCapture, true);
        try { prevActive && prevActive.focus && prevActive.focus(); } catch(e){}
      }

      function panelKeyCapture(e){
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
        if (path && path.some(node => node === panel || node === overlay || node === btn || node === shadowRoot || node === shadowHost)) {
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation(); closePanel(); return;
        }
        if (panelOpen) {
          if (/^F\d+$/.test(e.key)) return;
          e.preventDefault(); e.stopPropagation();
        }
      }

      // wire events
      btn.addEventListener('click', ()=>{ panel.style.display === 'block' ? closePanel() : openPanel(); });
      btn.addEventListener('keydown', (e)=>{ if(e.key==='Enter' || e.key===' ') { e.preventDefault(); panel.style.display === 'block' ? closePanel() : openPanel(); } });

      overlay.addEventListener('pointerdown', ()=>{ closePanel(); });

      btnRestore.addEventListener('click', ()=>{ targetsList = DEFAULT_TARGETS.slice(); const taEl = shadowRoot.querySelector('#ysc-targets-ta'); if(taEl) taEl.value = targetsList.join('\n'); updateNormalizedTargetsFromList(targetsList); });
      btnClear.addEventListener('click', ()=>{ cache.clear(); document.querySelectorAll('ytd-comment-thread-renderer').forEach(th=>{ th.removeAttribute('data-ysc-checked'); th.removeAttribute('data-ysc-invisible-comment'); }); stats = { blocked:0, failed:0, lastError: '' }; banner.style.display='none'; try{ alert('Cache cleared.'); }catch(e){} });
      btnCancel.addEventListener('click', ()=>{ closePanel(); });
      btnRetry.addEventListener('click', ()=>{ retryChecks(); try{ alert('checking all comments...'); }catch(e){} });
      btnSave.addEventListener('click', ()=>{
        const taEl = shadowRoot.querySelector('#ysc-targets-ta');
        const lines = taEl ? taEl.value.split(/\r?\n/).map(l=>l.trim()).filter(Boolean) : [];
        const displayList = lines.map(l => l.startsWith('@')?l:'@'+l);
        targetsList = displayList; saveTargets(displayList); updateNormalizedTargetsFromList(displayList);
        cache.clear();
        document.querySelectorAll('ytd-comment-thread-renderer').forEach(th=>{ th.removeAttribute('data-ysc-checked'); th.removeAttribute('data-ysc-invisible-comment'); });
        closePanel();
        try{ alert("LIST SAVED"); }catch(e){}
      });

    } catch (e) { dbg('createShadowUI error', e); }
  }

  // ---------- Banner helpers ----------
  let stats = { blocked:0, failed:0, lastError: '' };
  function renderBannerDetails(){ 
    if(!banner) return; 
    const bmsg = shadowRoot.getElementById ? shadowRoot.getElementById('ysc-banner-msg') : null; 
    if(!bmsg) return; 
    bmsg.textContent = stats.blocked>0
        ? `Warning: ${stats.blocked} request(s) may have been blocked by a filter/adblock.`
        : (stats.failed>0
            ? `Detected ${stats.failed} network error(s) while checking comments.`
            : 'OK — no issues.');
    banner.style.display='block'; 
  }

  function setError(kind, message){ if(kind==='blocked') stats.blocked++; else stats.failed++; stats.lastError = message?String(message):stats.lastError; renderBannerDetails(); }

  // ---------- Comment visibility check ----------
  function checkCommentVisibility(commentLink, parentEl){
    if(!commentLink){ parentEl.setAttribute('data-ysc-invisible-comment','banned'); safeUpdateIcon(); return; }
    const ck = commentLink; const cached = getCache(ck);
    if(cached){ parentEl.setAttribute('data-ysc-invisible-comment', cached); safeUpdateIcon(); dbg('cache hit', ck, cached); return; }
    parentEl.setAttribute('data-ysc-invisible-comment','checking'); safeUpdateIcon();
    enqueueTask(async ()=>{
      try{
        const res1 = await fetch(commentLink, { credentials:'include' });
        if(!res1.ok){ const msg=`Comment page HTTP ${res1.status}`; setCache(ck,'banned'); parentEl.setAttribute('data-ysc-invisible-comment','banned'); setError('failed', msg); safeUpdateIcon(); return; }
        const text = await res1.text();
        const pos = text.search('"continuationCommand"');
        if(pos === -1){ setCache(ck,'banned'); parentEl.setAttribute('data-ysc-invisible-comment','banned'); setError('failed','continuationCommand not found'); safeUpdateIcon(); return; }
        const continuation = text.substring(pos + 32, text.indexOf('"', pos + 32));
        const res2 = await fetch('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ context:{ client:{ clientName:'WEB', clientVersion:'2.20260811.01.00' } }, continuation }), credentials:'include' });
        if(!res2.ok){ const msg=`youtubei POST HTTP ${res2.status}`; const isBlocked = res2.status === 403 || res2.status === 401; setCache(ck,isBlocked?'blocked':'banned'); parentEl.setAttribute('data-ysc-invisible-comment', isBlocked?'blocked':'banned'); setError(isBlocked?'blocked':'failed', msg); safeUpdateIcon(); return; }
        const json = await res2.json();
        const mutations = json?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
        const lc = new URL(commentLink).searchParams.get('lc');
        const payload = mutations.filter(m => m?.payload?.commentEntityPayload?.properties?.commentId === lc)?.[0]?.payload ?? null;
        const state = payload ? 'valid' : 'banned';
        setCache(ck, state); parentEl.setAttribute('data-ysc-invisible-comment', state); safeUpdateIcon(); dbg('checked', commentLink, state);
      } catch(err){
        const msg = String(err || 'unknown'); const me = msg.toLowerCase();
        const isBlocked = me.includes('blocked')||me.includes('address_invalid')||me.includes('net::err_blocked_by_client')||me.includes('proxy')||me.includes('failed to fetch');
        setCache(ck, isBlocked ? 'blocked' : 'banned'); parentEl.setAttribute('data-ysc-invisible-comment', isBlocked ? 'blocked' : 'banned'); setError(isBlocked ? 'blocked' : 'failed', msg); safeUpdateIcon();
      }
    });
  }

  // ---------- Update icon + shadowban detection ----------
  function safeUpdateIcon(){
    try{
      if(!shadowRoot) createShadowUI();
      if(!btn) btn = shadowRoot && shadowRoot.querySelector && shadowRoot.querySelector('#ysc-btn');
      if(!btn) return;
      const threads = Array.from(document.querySelectorAll('ytd-comment-thread-renderer'));
      let total=0, valid=0, bannedCount=0, blockedCount=0, checking=0, shadowbanCount=0;
      const shadowbanExamples = [];
      for(const th of threads){
        const authorAnchor = th.querySelector('#author-text[href]') || th.querySelector('#author-text a');
        if(!authorAnchor) continue;
        if(!isTargetAuthorFromAnchor(authorAnchor)) continue;
        total++;
        const s = th.getAttribute('data-ysc-invisible-comment') || '';
        if(s==='valid') valid++; else if(s==='banned') bannedCount++; else if(s==='blocked') blockedCount++; else if(s==='checking') checking++;
        if(s === 'banned'){
          const txtEl = th.querySelector('#content-text');
          const visible = txtEl && txtEl.getClientRects && txtEl.getClientRects().length > 0;
          const text = txtEl ? (txtEl.textContent || '').trim() : '';
          if(visible && text.length > 0){
            shadowbanCount++;
            try{ shadowbanExamples.push({ href: authorAnchor.getAttribute('href'), name: authorAnchor.textContent.trim().slice(0,80) }); }catch(e){}
          }
        }
      }

      let color = '#ffeb3b', title = 'YSC: brak dopasowań';
      if(shadowbanCount > 0){ color = '#e53935'; title = `YSC: Shadowban suspected: ${shadowbanCount}`; }
      else if(total===0){ color='#ffeb3b'; title='YSC: brak dopasowań'; }
      else if(blockedCount>0){ color='#ff9800'; title=`YSC: ${blockedCount} zablokowane żądanie(ń)`; }
      else if(bannedCount>0){ color='#e53935'; title=`YSC: ${bannedCount} ukryte/usunięte komentarze`; }
      else if(checking>0 && valid===0){ color='#2196f3'; title=`YSC: sprawdzanie ${checking} komentarzy`; }
      else if(valid>0 && bannedCount===0 && blockedCount===0){ color='#4caf50'; title=`YSC: ${valid} widoczne komentarze (OK)`; }

      btn.style.setProperty('background', color, 'important');
      let extra = '';
      if(shadowbanCount>0 && shadowbanExamples.length) extra = '\nExamples: ' + shadowbanExamples.slice(0,3).map(e=>e.name+' ('+e.href+')').join(', ');
      btn.setAttribute('title', `${title}\n(valid:${valid}, banned:${bannedCount}, blocked:${blockedCount}, checking:${checking})${extra}`);
      btn.setAttribute('aria-busy', checking>0?'true':'false');

      if(shadowbanCount>0 && banner){
        banner.style.display = 'block';
        banner.style.setProperty('background', 'rgba(229, 57, 53, 0.95)', 'important');
        const bmsg = shadowRoot.getElementById && shadowRoot.getElementById('ysc-banner-msg');
        if(bmsg) bmsg.innerHTML = `<strong>Shadowban suspected!</strong><br/>→ window.__ysc_debugMatches().forEach(m => console.log(m.name, m.state, m.matched))`;
      }
    } catch(e){ dbg('safeUpdateIcon', e); }
  }

  // ---------- Debug helpers ----------
  window.__ysc_updateIcon = safeUpdateIcon;
  window.__ysc_debugMatches = function(){
    const out = [];
    document.querySelectorAll('ytd-comment-thread-renderer').forEach(th=>{
      const a = th.querySelector('#author-text[href]') || th.querySelector('#author-text a');
      if(!a) return;
      const href = a.getAttribute('href')||'';
      const nh = normalizeHref(href);
      const matched = isTargetAuthorFromAnchor(a);
      const state = th.getAttribute('data-ysc-invisible-comment');
      const textEl = th.querySelector('#content-text');
      const visible = textEl && textEl.getClientRects && textEl.getClientRects().length > 0;
      out.push({ href, nh, name: a.textContent.trim(), matched, state, visibleText: visible ? (textEl.textContent||'').trim().slice(0,160) : null });
    });
    console.log(out); return out;
  };
  window.__ysc_retryChecks = function(){ retryChecks(); };

  // ---------- Observers: Mutation -> Intersection ----------
  let io = null;
  function ensureIntersectionObserver(){
    if(io) return io;
    io = new IntersectionObserver(entries=>{
      entries.forEach(en=>{
        if(en.isIntersecting){
          const th = en.target;
          processThreadIfNeeded(th);
          try{ io.unobserve(th); }catch(e){}
        }
      });
    }, { root: null, rootMargin: '0px', threshold: 0.01 });
    return io;
  }

  function processThreadIfNeeded(thread){
    try{
      if(thread.hasAttribute('data-ysc-checked')) return;
      const authorAnchor = thread.querySelector('#author-text[href]') || thread.querySelector('#author-text a');
      if(!authorAnchor) return;
      if(!isTargetAuthorFromAnchor(authorAnchor)) return;
      thread.setAttribute('data-ysc-checked','1');
      thread.setAttribute('data-ysc-invisible-comment','checking');
      safeUpdateIcon();
      const timeLinkEl = thread.querySelector('#published-time-text a');
      const commentLink = timeLinkEl?.href || null;
      const cached = commentLink ? getCache(commentLink) : null;
      if(cached){ thread.setAttribute('data-ysc-invisible-comment', cached); safeUpdateIcon(); dbg('applied cache', cached, commentLink); return; }
      checkCommentVisibility(commentLink, thread);
    } catch(e){ dbg('processThreadIfNeeded', e); }
  }

  let mutationObserver = null;
  function ensureMutationObserver(){
    if(mutationObserver) return;
    mutationObserver = new MutationObserver(muts=>{
      for(const m of muts){
        for(const n of m.addedNodes){
          try{
            if(!n.querySelectorAll) continue;
            const threads = n.querySelectorAll('ytd-comment-thread-renderer');
            threads.forEach(th => { try{ ensureIntersectionObserver().observe(th); }catch(e){} });
            if(n.matches && n.matches('ytd-comment-thread-renderer')) ensureIntersectionObserver().observe(n);
          } catch(e){ dbg('mutation loop', e); }
        }
      }
    });
    try{ mutationObserver.observe(document.body, { childList: true, subtree: true }); } catch(e){ dbg('mutationObserver start', e); }
  }

  function registerExistingThreads(){
    const threads = document.querySelectorAll('ytd-comment-thread-renderer');
    const ob = ensureIntersectionObserver();
    threads.forEach(th => { try{ ob.observe(th); } catch(e){ dbg('observe thread', e); } });
  }

  // debounced scroll to catch fast navigation
  let scrollTimer = null;
  function debouncedScrollHandler(){
    if(scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(()=>{
      const threads = Array.from(document.querySelectorAll('ytd-comment-thread-renderer'));
      const vhBottom = window.innerHeight || document.documentElement.clientHeight;
      threads.forEach(th=>{
        try{
          if(th.hasAttribute('data-ysc-checked')) return;
          const r = th.getBoundingClientRect();
          if(r.bottom >= 0 && r.top <= vhBottom){
            processThreadIfNeeded(th);
            try{ io && io.unobserve && io.unobserve(th); }catch(e){}
          }
        }catch(e){}
      });
    }, 350);
  }

  // fallback periodic update
  setInterval(()=>{ try{ safeUpdateIcon(); } catch(e){ dbg('fallback updateIcon', e); } }, 30_000);

  // retry/reset
  function retryChecks(){
    document.querySelectorAll('ytd-comment-thread-renderer').forEach(th=>{
      const s = th.getAttribute('data-ysc-invisible-comment');
      if(s==='blocked' || s==='banned' || s==='checking'){ th.removeAttribute('data-ysc-checked'); th.removeAttribute('data-ysc-invisible-comment'); const tl = th.querySelector('#published-time-text a'); if(tl?.href) cache.delete(tl.href); }
    });
    stats = { blocked:0, failed:0, lastError: '' };
    if(banner) banner.style.display = 'none';
    safeUpdateIcon();
  }

  // cleanup cache
  setInterval(()=>{ const now = Date.now(); for(const [k,v] of cache.entries()) if(now - v.ts > CACHE_TTL) cache.delete(k); }, CACHE_TTL);

  // ---------- Bootstrap ----------
  try {
    createShadowUI();
    ensureMutationObserver();
    registerExistingThreads();
    window.addEventListener('scroll', debouncedScrollHandler, { passive:true });
    window.addEventListener('resize', debouncedScrollHandler, { passive:true });
    setTimeout(()=>{ debouncedScrollHandler(); safeUpdateIcon(); }, 1000);
    dbg('YSC loaded (final).');
  } catch(e){ dbg('bootstrap', e); }

})();