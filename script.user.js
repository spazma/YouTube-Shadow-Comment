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
  const IGNORE_INITIAL_THREADS_ON_LOAD = true;
  const AUTO_CLEAR_CACHE_ON_LOAD = true;
  const AUTO_CLEAR_WAIT_MS = 300;
  const COMMENTS_WAIT_TIMEOUT = 5000;

  function dbg(...a){ if (DEBUG) console.log('[YSC]', ...a); }

  // --- Inject page highlight styles (so highlights affect YouTube DOM, not Shadow)
  (function injectPageHighlightStyles(){
    try {
      if (document.getElementById('ysc-page-styles')) return;
      const s = document.createElement('style'); s.id = 'ysc-page-styles';
      s.textContent = `
        /* Only style threads we explicitly marked as target (no "checking" visual) */
        ytd-comment-thread-renderer[data-ysc-target][data-ysc-invisible-comment="banned"] { background-color: rgba(255,0,0,0.12) !important; }
        ytd-comment-thread-renderer[data-ysc-target][data-ysc-invisible-comment="valid"] { background-color: rgba(3,255,36,0.12) !important; }
        ytd-comment-thread-renderer[data-ysc-target][data-ysc-invisible-comment="blocked"] { outline: 2px dashed orange !important; }
        ytd-comment-thread-renderer[data-ysc-target][data-ysc-invisible-comment] ytd-comment-renderer,
        ytd-comment-thread-renderer[data-ysc-target][data-ysc-invisible-comment] #content { background-clip: padding-box !important; }
      `;
      document.head.appendChild(s);
    } catch (e) { console.warn('YSC: injectPageHighlightStyles failed', e); }
  })();

  // ---------- Storage / Targets ----------
  function loadTargets(){ try { const raw = localStorage.getItem(STORAGE_KEY); if(!raw) return DEFAULT_TARGETS.slice(); const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : DEFAULT_TARGETS.slice(); } catch(e) { return DEFAULT_TARGETS.slice(); } }
  function saveTargets(list){ try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch(e) { console.warn('YSC save', e); } }
  let targetsList = loadTargets();
  let normalizedTargets = new Set();

  // normalize targets to lowercase alphanumeric-only strings (removes dots/underscores etc.)
  function updateNormalizedTargetsFromList(list){
    normalizedTargets = new Set(
      list
        .map(t => (t||'').toString().trim().replace(/^@+/, '').toLowerCase())
        .map(s => s.replace(/[^a-z0-9]+/g,'')) // reduce to alphanumeric
        .filter(Boolean)
    );
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
  function normalizeHref(h){
    if(!h) return '';
    try {
      const u = new URL(h, location.origin);
      let p = (u.pathname || '').replace(/\/+$/,'');
      p = p.split(/[?#]/)[0];
      p = p.replace(/[.]+$/,'');
      p = p.replace(/[^a-z0-9@._-]+$/i,'');
      if(p.startsWith('/')) p = p.slice(1);
      return p.toLowerCase();
    } catch(e) {
      let p = (h||'').split(/[?#]/)[0].replace(/\/+$/,'');
      p = p.replace(/[.]+$/,'').replace(/[^a-z0-9@._-]+$/i,'');
      if(p.startsWith('/')) p = p.slice(1);
      return p.toLowerCase();
    }
  }

  function lastSegment(path){ if(!path) return ''; const ps = path.split('/'); return ps[ps.length-1] || ''; }
  function isRecognizedAuthorHref(hrefNorm){ if(!hrefNorm) return false; return hrefNorm.startsWith('@') || hrefNorm.startsWith('channel/') || hrefNorm.startsWith('user/') || hrefNorm.startsWith('c/'); }

  // normalized comparison helper (alphanumeric only)
  const normForCompare = str => (str||'').toString().toLowerCase().replace(/^@+/,'').replace(/[^a-z0-9]+/g,'');

  // match only when normalized alphanumeric last segment (or display @name) equals a target
  function isTargetAuthorFromAnchor(authorAnchor){
    if(!authorAnchor) return false;
    const href = (authorAnchor.getAttribute('href') || '').trim();
    const displayName = (authorAnchor.textContent || '').trim().toLowerCase();

    if(href){
      const nh = normalizeHref(href);
      if(!nh) return false;
      if(!isRecognizedAuthorHref(nh)) return false;
      const segs = nh.split('/').filter(Boolean);
      if(segs.length === 0) return false;
      const lastSeg = segs[segs.length - 1];
      return normalizedTargets.has( normForCompare(lastSeg) );
    }

    // if no href, only match when displayName explicitly starts with @ and matches exactly (after normalization)
    if(displayName && displayName.startsWith('@')){
      return normalizedTargets.has( normForCompare(displayName) );
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

      // CLEAR CACHE -> clear cache and restart checks
      btnClear.addEventListener('click', ()=>{
        cache.clear();
        try { retryChecks(); } catch(e) { dbg('retry on clear failed', e); }
        try{ alert('Cache cleared.'); }catch(e){}
      });

      btnCancel.addEventListener('click', ()=>{ closePanel(); });
      btnRetry.addEventListener('click', ()=>{ retryChecks(); try{ alert('checking all comments...'); }catch(e){} });
      btnSave.addEventListener('click', ()=>{
        const taEl = shadowRoot.querySelector('#ysc-targets-ta');
        const lines = taEl ? taEl.value.split(/\r?\n/).map(l=>l.trim()).filter(Boolean) : [];
        const displayList = lines.map(l => l.startsWith('@')?l:'@'+l);
        targetsList = displayList; saveTargets(displayList); updateNormalizedTargetsFromList(displayList);
        cache.clear();
        document.querySelectorAll('ytd-comment-thread-renderer').forEach(th=>{ th.removeAttribute('data-ysc-checked'); th.removeAttribute('data-ysc-invisible-comment'); th.removeAttribute('data-ysc-target'); });
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
    if(!parentEl || !parentEl.hasAttribute('data-ysc-target')) return; // operate only on threads we marked
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

  // ---------- Scrub stale highlights (single node) ----------
  const scrubTimestamps = new WeakMap();
  const SCRUB_THROTTLE_MS = 200;
  function scrubThreadIfNotTarget(th){
    try{
      if(!th || th.nodeType !== 1) return;
      const last = scrubTimestamps.get(th) || 0;
      const now = Date.now();
      if(now - last < SCRUB_THROTTLE_MS) return;
      scrubTimestamps.set(th, now);
      const authorAnchor = th.querySelector('#author-text[href]') || th.querySelector('#author-text a');
      if(!authorAnchor || !isTargetAuthorFromAnchor(authorAnchor)){
        th.removeAttribute('data-ysc-invisible-comment');
        th.removeAttribute('data-ysc-checked');
        th.removeAttribute('data-ysc-target');
        dbg('scrubbed non-target thread');
      }
    } catch(e){ dbg('scrubThreadIfNotTarget', e); }
  }

  // full scrub for all (fallback)
  function scrubFalseHighlights(){
    try {
      document.querySelectorAll('ytd-comment-thread-renderer[data-ysc-invisible-comment], ytd-comment-thread-renderer[data-ysc-target]').forEach(th => {
        scrubThreadIfNotTarget(th);
      });
      safeUpdateIcon();
      dbg('scrubFalseHighlights done');
    } catch(e){ dbg('scrubFalseHighlights', e); }
  }

  // ---------- Mutation observer to continuously scrub injected attributes ----------
  let scrubObserver = null;
  function startScrubObserver(){
    if(scrubObserver) return;
    try{
      scrubObserver = new MutationObserver((mutations) => {
        for(const m of mutations){
          if(m.type === 'attributes'){
            const target = m.target;
            // if attribute change happened on a comment thread or child, find top thread
            const th = target.closest && target.closest('ytd-comment-thread-renderer');
            if(th) scrubThreadIfNotTarget(th);
            else if(target.matches && target.matches('ytd-comment-thread-renderer')) scrubThreadIfNotTarget(target);
          } else if(m.type === 'childList'){
            // new nodes added: check for any threads inside
            m.addedNodes.forEach(n => {
              try {
                if(!n.querySelectorAll) return;
                if(n.nodeType !== 1) return;
                if(n.matches && n.matches('ytd-comment-thread-renderer')) scrubThreadIfNotTarget(n);
                const threads = n.querySelectorAll('ytd-comment-thread-renderer');
                threads.forEach(t => scrubThreadIfNotTarget(t));
              } catch(e){}
            });
          }
        }
        // update icon after handling batch
        safeUpdateIcon();
      });
      scrubObserver.observe(document.documentElement || document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ysc-invisible-comment','data-ysc-checked','data-ysc-target'] });
      dbg('scrubObserver started');
    } catch(e){ dbg('startScrubObserver', e); }
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

  // initial threads set (WeakSet of nodes present at initial load)
  let initialThreads = new WeakSet();

  // process and mark thread as target (so CSS applies only to those we mark)
  function processThreadIfNeeded(thread){
    try{
      if(thread.hasAttribute('data-ysc-checked')) return;
      if(IGNORE_INITIAL_THREADS_ON_LOAD && initialThreads && initialThreads.has && initialThreads.has(thread)) return;
      const authorAnchor = thread.querySelector('#author-text[href]') || thread.querySelector('#author-text a');
      if(!authorAnchor) return;
      if(!isTargetAuthorFromAnchor(authorAnchor)) return;
      // mark as target so CSS will apply
      thread.setAttribute('data-ysc-target','1');
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
            threads.forEach(th => {
              try{
                // remove any stale attributes on newly added threads
                th.removeAttribute('data-ysc-checked');
                th.removeAttribute('data-ysc-invisible-comment');
                th.removeAttribute('data-ysc-target');
                ensureIntersectionObserver().observe(th);
              }catch(e){ dbg('observe thread (mutation)', e); }
            });
            if(n.matches && n.matches('ytd-comment-thread-renderer')){
              try{
                n.removeAttribute('data-ysc-checked');
                n.removeAttribute('data-ysc-invisible-comment');
                n.removeAttribute('data-ysc-target');
                ensureIntersectionObserver().observe(n);
              }catch(e){}
            }
          } catch(e){ dbg('mutation loop', e); }
        }
      }
    });
    try{ mutationObserver.observe(document.body, { childList: true, subtree: true }); } catch(e){ dbg('mutationObserver start', e); }
  }

  function registerExistingThreads(){
    const threads = document.querySelectorAll('ytd-comment-thread-renderer');
    const ob = ensureIntersectionObserver();
    threads.forEach(th => { try{ th.removeAttribute('data-ysc-checked'); th.removeAttribute('data-ysc-invisible-comment'); th.removeAttribute('data-ysc-target'); ob.observe(th); } catch(e){ dbg('observe thread', e); } });
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

  // ---------- Immediate visible processing (for retry/clear) ----------
  function processVisibleThreadsNow(){
    try {
      const threads = Array.from(document.querySelectorAll('ytd-comment-thread-renderer'));
      const vhBottom = window.innerHeight || document.documentElement.clientHeight;
      for(const th of threads){
        try{
          if(th.hasAttribute('data-ysc-checked')) continue;
          const r = th.getBoundingClientRect();
          if(r.bottom >= 0 && r.top <= vhBottom){
            processThreadIfNeeded(th);
            try{ io && io.unobserve && io.unobserve(th); }catch(e){}
          }
        } catch(e){}
      }
    } catch(e){ dbg('processVisibleThreadsNow', e); }
  }

  setInterval(()=>{ try{ safeUpdateIcon(); } catch(e){ dbg('fallback updateIcon', e); } }, 30_000);

  // retry/reset (single canonical implementation) - now re-registers and immediately processes visible threads
  function retryChecks(){
    initialThreads = new WeakSet();
    document.querySelectorAll('ytd-comment-thread-renderer').forEach(th=>{
      th.removeAttribute('data-ysc-checked');
      th.removeAttribute('data-ysc-invisible-comment');
      th.removeAttribute('data-ysc-target');
      const tl = th.querySelector('#published-time-text a');
      if(tl?.href) cache.delete(tl.href);
    });
    stats = { blocked:0, failed:0, lastError: '' };
    if(banner) banner.style.display = 'none';
    try { registerExistingThreads(); } catch(e){ dbg('registerExistingThreads failed', e); }
    try { setTimeout(processVisibleThreadsNow, 30); } catch(e){ processVisibleThreadsNow(); }
    try { scrubFalseHighlights(); } catch(e){ dbg('scrubFalseHighlights failed in retryChecks', e); }
    safeUpdateIcon();
  }

  // cleanup cache
  setInterval(()=>{ const now = Date.now(); for(const [k,v] of cache.entries()) if(now - v.ts > CACHE_TTL) cache.delete(k); }, CACHE_TTL);

  // ---------- Helper: wait for comments area then auto-clear+retry ----------
  function waitForCommentsAndAutoClear(timeout = COMMENTS_WAIT_TIMEOUT){
    return new Promise(resolve => {
      let resolved = false;
      const finish = (didFind) => {
        if(resolved) return;
        resolved = true;
        try { obs && obs.disconnect(); } catch(e){}
        resolve(didFind);
      };

      const existing = document.querySelector('ytd-comments, #comments');
      if(existing){
        finish(true);
      } else {
        const obs = new MutationObserver((mutations, o) => {
          if(document.querySelector('ytd-comments, #comments')){
            finish(true);
          }
        });
        try { obs.observe(document.documentElement || document.body, { childList: true, subtree: true }); } catch(e){ finish(false); }
        setTimeout(()=> finish(!!document.querySelector('ytd-comments, #comments')), timeout);
      }
    }).then(found => {
      if(found){
        setTimeout(()=> {
          if(AUTO_CLEAR_CACHE_ON_LOAD){
            try { cache.clear(); } catch(e){}
          }
          try { retryChecks(); } catch(e){ dbg('auto retryChecks failed', e); }
          try { scrubFalseHighlights(); } catch(e){ dbg('scrubFalseHighlights failed after auto retry', e); }
        }, AUTO_CLEAR_WAIT_MS);
      } else {
        dbg('comments area not found within timeout');
      }
    });
  }

  // ---------- SPA navigation handling ----------
  try {
    document.addEventListener('yt-navigate-finish', ()=> {
      try {
        waitForCommentsAndAutoClear().catch(e=>dbg('waitForCommentsAndAutoClear nav err',e));
      } catch(e){ dbg('yt-navigate-finish retry failed', e); }
    }, { passive:true });
  } catch(e){ dbg('nav listener', e); }

  // Auto-clear+retry on first user interaction after load (fallback)
  (function setupAutoRetryOnFirstInteraction(){
    let done = false;
    const events = ['mousemove','pointermove','scroll','touchstart','keydown','focus'];
    function handler(e){
      if(done) return;
      done = true;
      try { cache.clear(); retryChecks(); dbg('auto clear+retry triggered by', e.type); } catch(err){ dbg('auto clear+retry failed', err); }
      events.forEach(ev => window.removeEventListener(ev, handler, true));
    }
    events.forEach(ev => window.addEventListener(ev, handler, { passive: true, capture: true }));
    setTimeout(()=>{ if(!done){ done = true; events.forEach(ev => window.removeEventListener(ev, handler, true)); dbg('auto-retry listeners removed after timeout'); } }, 10000);
  })();

  // ---------- Start scrub observer ----------
  try { startScrubObserver(); } catch(e){ dbg('startScrubObserver failed at init', e); }

  // ---------- Bootstrap ----------
  try {
    if(IGNORE_INITIAL_THREADS_ON_LOAD){
      try {
        initialThreads = new WeakSet();
        document.querySelectorAll('ytd-comment-thread-renderer').forEach(th => {
          try { initialThreads.add(th); } catch(e){}
        });
        dbg('initialThreads snapshot taken, count (approx):', document.querySelectorAll('ytd-comment-thread-renderer').length);
      } catch(e){ dbg('initialThreads snapshot failed', e); initialThreads = new WeakSet(); }
    } else {
      initialThreads = new WeakSet();
    }

    createShadowUI();
    ensureMutationObserver();
    registerExistingThreads();
    // scrub any stale highlights left over from previous runs / page load
    try { scrubFalseHighlights(); } catch(e){ dbg('scrubFalseHighlights failed in bootstrap', e); }

    window.addEventListener('scroll', debouncedScrollHandler, { passive:true });
    window.addEventListener('resize', debouncedScrollHandler, { passive:true });

    setTimeout(()=>{ debouncedScrollHandler(); safeUpdateIcon(); }, 1000);

    try { waitForCommentsAndAutoClear().catch(e=>dbg('waitForCommentsAndAutoClear startup err',e)); } catch(e) { dbg('waitForCommentsAndAutoClear failed', e); }

    dbg('YSC loaded (final).');
  } catch(e){ dbg('bootstrap', e); }

})();