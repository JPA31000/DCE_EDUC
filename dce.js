/* ---- m0_pdfium.js ---- */
/* ==================================================================================================
   DCE Educ — m0_pdfium : lecture des PDF par PDFium (moteur PDF de Chrome, licence BSD / Apache 2.0,
   compilé en WebAssembly par @embedpdf/pdfium, licence MIT).
   Donne pour chaque page : les textes positionnés, les tracés vectoriels exacts (segments, couleurs,
   épaisseurs) et un rendu en pixels sans les textes. Fonctionne dans l'appli et sous Node (essais).
   Repère de sortie : points PDF, origine en haut à gauche, y vers le bas, rotation de page appliquée.
   ================================================================================================== */
'use strict';
(function (root) {
  let M = null, P = null;                        // fonctions PDFium enveloppées, exécution Emscripten

  async function init(wasmBinary, initFn) {
    if (M) return;
    M = await initFn({ wasmBinary, locateFile: p => p });
    M.PDFiumExt_Init();
    P = M.pdfium;
  }
  const malloc = n => P.wasmExports.malloc(n), free = p => P.wasmExports.free(p);
  const heap = () => (P.wasmExports.memory ? new Uint8Array(P.wasmExports.memory.buffer) : P.HEAPU8);
  const f32 = p => P.getValue(p, 'float'), i32 = p => P.getValue(p, 'i32');
  // une zone de travail réutilisée pour les sorties des fonctions (6 flottants, 4 entiers…)
  let SCR = 0; const scr = () => SCR || (SCR = malloc(64));

  const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
  const ap = (A, x, y) => [A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]];
  const ID = [1, 0, 0, 1, 0, 0];
  const ap6 = mul;   // composition : affichage ∘ matrice du caractère

  function objMatrix(o) {
    const s = scr();
    if (!M.FPDFPageObj_GetMatrix(o, s)) return ID;
    return [f32(s), f32(s + 4), f32(s + 8), f32(s + 12), f32(s + 16), f32(s + 20)];
  }
  function color(o, stroke) {
    const s = scr();
    const ok = stroke ? M.FPDFPageObj_GetStrokeColor(o, s, s + 4, s + 8, s + 12) : M.FPDFPageObj_GetFillColor(o, s, s + 4, s + 8, s + 12);
    return ok ? [i32(s), i32(s + 4), i32(s + 8), i32(s + 12)] : null;
  }

  function open(bytes) {
    const ptr = malloc(bytes.length);
    heap().set(bytes, ptr);            // vue fraîche de la mémoire (elle a pu grandir pendant malloc)
    const doc = M.FPDF_LoadMemDocument(ptr, bytes.length, '');
    if (!doc) { free(ptr); throw new Error('PDF illisible (code PDFium ' + M.FPDF_GetLastError() + ')'); }
    const D = {
      numPages: M.FPDF_GetPageCount(doc),
      getPage: async i => new Page(doc, i),
      close() { M.FPDF_CloseDocument(doc); free(ptr); }
    };
    return D;
  }

  class Page {
    constructor(doc, i) {
      this.doc = doc; this.i = i;
      this.h = M.FPDF_LoadPage(doc, i - 1);
      if (!this.h) throw new Error('page ' + i + ' illisible');
      this.W = M.FPDF_GetPageWidthF(this.h); this.H = M.FPDF_GetPageHeightF(this.h);
      // repère page PDF → affichage (y vers le bas, rotation appliquée), déduit de trois points
      const K = 16, s = scr(), w = Math.round(this.W * K), h = Math.round(this.H * K);
      const dev = (x, y) => { M.FPDF_PageToDevice(this.h, 0, 0, w, h, 0, x, y, s, s + 4); return [i32(s) / K, i32(s + 4) / K]; };
      const O = dev(0, 0), X = dev(1000, 0), Y = dev(0, 1000);
      this.T = [(X[0] - O[0]) / 1000, (X[1] - O[1]) / 1000, (Y[0] - O[0]) / 1000, (Y[1] - O[1]) / 1000, O[0], O[1]];
      this._text = null; this.textGone = false;
    }
    // une page de plan peut peser des centaines de Mo dans PDFium : on la libère dès qu'elle est lue,
    // et on la recharge à la demande (les textes restent en mémoire, côté JavaScript)
    load() { if (!this.h) { this.h = M.FPDF_LoadPage(this.doc, this.i - 1); this.textGone = false; if (!this.h) throw new Error('page ' + this.i + ' illisible'); } return this.h; }
    release() { if (this.h) { M.FPDF_ClosePage(this.h); this.h = 0; this.textGone = false; } }
    // parcours des objets de la page, formulaires (XObject) compris, avec la matrice cumulée
    walk(fn) {
      this.load();
      const rec = (get, n, A, parent) => {
        for (let k = 0; k < n; k++) {
          const o = get(k); if (!o) continue;
          const t = M.FPDFPageObj_GetType(o);
          if (t === 5) { const B = mul(A, objMatrix(o)); rec(j => M.FPDFFormObj_GetObject(o, j), M.FPDFFormObj_CountObjects(o), B, o); }
          else fn(o, t, A, parent);
        }
      };
      rec(k => M.FPDFPage_GetObject(this.h, k), M.FPDFPage_CountObjects(this.h), this.T, null);
    }
    // textes : reconstruits caractère par caractère (comme pdf.js) — un morceau par suite de caractères
    // d'une même ligne ; un grand blanc (colonne de tableau) coupe le morceau, même dans un seul objet texte
    text() {
      if (this._text) return this._text;
      this.load();
      const tp = M.FPDFText_LoadPage(this.h), nc = M.FPDFText_CountChars(tp), sc = scr(), T = this.T;
      const info = new Map(), items = [];
      let run = null, space = false;
      const flush = () => { if (run) { run.s = run.s.replace(/\s+/g, ' ').trim(); if (run.s) items.push(run); } run = null; };
      for (let i = 0; i < nc; i++) {
        const u = M.FPDFText_GetUnicode(tp, i);
        if (u === 13 || u === 10) { flush(); space = false; continue; }          // retour à la ligne produit par PDFium
        if (u === 32 || u === 9 || u === 0xa0 || u === 0) { space = true; continue; }
        const o = M.FPDFText_GetTextObject(tp, i);
        let inf = info.get(o);
        if (!inf) {
          let m = T;
          if (M.FPDFText_GetMatrix(tp, i, sc)) m = mul(T, [f32(sc), f32(sc + 4), f32(sc + 8), f32(sc + 12), f32(sc + 16), f32(sc + 20)]);
          let fs = 0; if (o && M.FPDFTextObj_GetFontSize(o, sc)) fs = f32(sc);
          const ang = Math.atan2(m[1], m[0]);
          inf = { ang, c: Math.cos(ang), s: Math.sin(ang), size: fs * Math.hypot(m[2], m[3]) };
          info.set(o, inf);
        }
        // boîte « large » du caractère (avance comprise) : les blancs entre caractères sont alors de vrais espaces
        let l, r, bo, to;
        if (M.FPDFText_GetLooseCharBox(tp, i, sc)) { l = f32(sc); to = f32(sc + 4); r = f32(sc + 8); bo = f32(sc + 12); }
        else if (M.FPDFText_GetCharBox(tp, i, sc, sc + 8, sc + 16, sc + 24)) { l = P.getValue(sc, 'double'); r = P.getValue(sc + 8, 'double'); bo = P.getValue(sc + 16, 'double'); to = P.getValue(sc + 24, 'double'); }
        else continue;
        const Q = [[l, bo], [r, bo], [r, to], [l, to]].map(p => ap(T, p[0], p[1]));
        const xs = Q.map(p => p[0]), ys = Q.map(p => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const size = inf.size || Math.max(y1 - y0, 1);
        const al = Q.map(p => p[0] * inf.c + p[1] * inf.s), ac = Q.map(p => -p[0] * inf.s + p[1] * inf.c);
        const a0 = Math.min(...al), a1 = Math.max(...al), cc = (Math.min(...ac) + Math.max(...ac)) / 2;
        const ch = String.fromCodePoint(u);
        if (run) {
          const gap = a0 - run.a1;
          const same = Math.abs(run.ang - inf.ang) < 0.05 && Math.abs(cc - run.c) < 0.5 * Math.max(size, run.size) && gap < 1.0 * Math.max(size, run.size) && gap > -0.6 * Math.max(size, run.size);
          if (!same) flush();
        }
        if (!run) run = { s: ch, x0, y0, x1, y1, size, ang: inf.ang, a1, c: cc };
        else {
          run.s += (space || (a0 - run.a1) > 0.22 * size ? ' ' : '') + ch;
          run.x0 = Math.min(run.x0, x0); run.y0 = Math.min(run.y0, y0); run.x1 = Math.max(run.x1, x1); run.y1 = Math.max(run.y1, y1);
          run.a1 = Math.max(run.a1, a1); run.size = Math.max(run.size, size);
        }
        space = false;
      }
      flush(); M.FPDFText_ClosePage(tp);
      items.forEach(it => { it.cx = (it.x0 + it.x1) / 2; it.cy = (it.y0 + it.y1) / 2; delete it.a1; delete it.c; });
      this._text = { items, W: this.W, H: this.H };
      return this._text;
    }
    // tracés vectoriels : un enregistrement par objet chemin, points en repère d'affichage
    paths(opts = {}) {
      const out = [], s = scr();
      this.walk((o, t, A) => {
        if (t !== 2) return;
        const n = M.FPDFPath_CountSegments(o); if (n <= 0) return;
        const m = mul(A, objMatrix(o));
        if (opts.bbox) { // filtre rapide sur la boîte de l'objet
          if (!M.FPDFPageObj_GetBounds(o, s, s + 4, s + 8, s + 12)) return;
        }
        const pts = new Float32Array(n * 2), ty = new Uint8Array(n); let closed = false;
        for (let k = 0; k < n; k++) {
          const g = M.FPDFPath_GetPathSegment(o, k);
          M.FPDFPathSegment_GetPoint(g, s, s + 4);
          const p = ap(m, f32(s), f32(s + 4)); pts[2 * k] = p[0]; pts[2 * k + 1] = p[1];
          ty[k] = M.FPDFPathSegment_GetType(g) + (M.FPDFPathSegment_GetClose(g) ? 8 : 0);   // 0 trait, 1 courbe, 2 déplacement ; +8 fermé
          if (ty[k] & 8) closed = true;
        }
        let mode = 0, stroke = false;
        if (M.FPDFPath_GetDrawMode(o, s, s + 4)) { mode = i32(s); stroke = !!i32(s + 4); }
        let lw = 0; if (stroke && M.FPDFPageObj_GetStrokeWidth(o, s)) lw = f32(s) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        out.push({ pts, ty, closed, fill: mode ? color(o, false) : null, stroke: stroke ? color(o, true) : null, lw, dash: M.FPDFPageObj_GetDashCount(o) > 0 });
      });
      return out;
    }
    // arcs de cercle des tracés (débattements de portes, par exemple) : centre, rayon, ouverture angulaire (repère d'affichage, points)
    // une courbe de Bézier = un morceau d'arc ; les morceaux contigus de même centre sont réunis
    arcs(rMin = 10, rMax = 200) {
      const out = [], s = scr();
      this.walk((o, t, A) => {
        if (t !== 2) return;
        const n = M.FPDFPath_CountSegments(o); if (n < 2 || n > 400) return;
        let hasCurve = false; for (let k = 0; k < n && !hasCurve; k++) if (M.FPDFPathSegment_GetType(M.FPDFPath_GetPathSegment(o, k)) === 1) hasCurve = true;
        if (!hasCurve) return;
        const m = mul(A, objMatrix(o)), P_ = [], T_ = [];
        for (let k = 0; k < n; k++) { const g = M.FPDFPath_GetPathSegment(o, k); M.FPDFPathSegment_GetPoint(g, s, s + 4); P_.push(ap(m, f32(s), f32(s + 4))); T_.push(M.FPDFPathSegment_GetType(g)); }
        let cur = null, prev = null;
        for (let k = 0; k < n; k++) {
          if (T_[k] === 1 && k + 2 < n && prev) {
            const a = prev, d = P_[k + 2];
            // point au milieu de la courbe, puis cercle passant par début, milieu et fin
            const b = P_[k], c = P_[k + 1], mid = [(a[0] + 3 * b[0] + 3 * c[0] + d[0]) / 8, (a[1] + 3 * b[1] + 3 * c[1] + d[1]) / 8];
            const C = circum(a, mid, d);
            if (C) {
              const r = Math.hypot(a[0] - C[0], a[1] - C[1]);
              let sw = Math.abs(angDiff(Math.atan2(a[1] - C[1], a[0] - C[0]), Math.atan2(d[1] - C[1], d[0] - C[0])));
              if (cur && Math.hypot(cur.c[0] - C[0], cur.c[1] - C[1]) < 0.08 * r && Math.abs(cur.r - r) < 0.08 * r) { cur.sw += sw; cur.p1 = d; }
              else { if (cur) out.push(cur); cur = { c: C, r, sw, p0: a, p1: d }; }
            }
            prev = d; k += 2; continue;
          }
          if (cur) { out.push(cur); cur = null; }
          prev = P_[k];
        }
        if (cur) out.push(cur);
      });
      return out.filter(a => a.r >= rMin && a.r <= rMax).map(a => ({ c: a.c, r: a.r, sw: a.sw * 180 / Math.PI, p0: a.p0, p1: a.p1 }));
    }
    // petits segments droits (arcs dessinés en facettes par les exports DWG → PDF) : [x0,y0,x1,y1,…] en points
    shortSegments(maxLen = 12, minLen = 0.3, maxN = 2000) {
      const out = [], s = scr(), mx2 = maxLen * maxLen, mn2 = minLen * minLen;
      this.walk((o, t, A) => {
        if (t !== 2) return;
        const n = M.FPDFPath_CountSegments(o); if (n < 2 || n > maxN) return;   // (un arc peut être une seule polyligne de nombreux sommets)
        // (les débattements sont souvent en pointillés : on les garde)
        const m = mul(A, objMatrix(o)); let px = 0, py = 0;
        for (let k = 0; k < n; k++) {
          const g = M.FPDFPath_GetPathSegment(o, k); M.FPDFPathSegment_GetPoint(g, s, s + 4);
          const x = f32(s), y = f32(s + 4), X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
          if (k && M.FPDFPathSegment_GetType(g) === 0) { const d2 = (X - px) ** 2 + (Y - py) ** 2; if (d2 <= mx2 && d2 >= mn2) out.push(px, py, X, Y); }
          px = X; py = Y;
        }
      });
      return new Float32Array(out);
    }
    // visionneuse : rendu fidèle (textes, lissage, annotations) d'une fenêtre de la page [x0,y0,w,h en points] dans outW × outH pixels, RVBA
    view(x0, y0, wpt, hpt, outW, outH) {
      if (this.textGone) this.release();          // une page déjà lue sans ses textes est rechargée telle quelle
      this.load();
      // la matrice s'applique APRÈS le repère d'affichage de PDFium (points, y vers le bas, rotation de page faite)
      const k = outW / wpt, s = scr(), mp = s, cp = s + 32;
      [k, 0, 0, k, -k * x0, -k * y0].forEach((v, i) => P.setValue(mp + 4 * i, v, 'float'));
      [0, 0, outW, outH].forEach((v, i) => P.setValue(cp + 4 * i, v, 'float'));
      const bmp = M.FPDFBitmap_Create(outW, outH, 0);
      M.FPDFBitmap_FillRect(bmp, 0, 0, outW, outH, 0xFFFFFFFF);
      M.FPDF_RenderPageBitmapWithMatrix(bmp, this.h, mp, cp, 0x01);           // 0x01 : annotations comprises
      const buf = M.FPDFBitmap_GetBuffer(bmp), stride = M.FPDFBitmap_GetStride(bmp), H8 = heap(), out = new Uint8ClampedArray(outW * outH * 4);
      for (let y = 0; y < outH; y++) { let si = buf + y * stride, di = y * outW * 4; for (let x = 0; x < outW; x++, si += 4, di += 4) { out[di] = H8[si + 2]; out[di + 1] = H8[si + 1]; out[di + 2] = H8[si]; out[di + 3] = 255; } }
      M.FPDFBitmap_Destroy(bmp);
      return out;
    }
    // rendu en pixels (RVB, fond blanc) à s pixels par point, textes retirés, sans lissage
    raster(s, maxPx = 36e6) {
      this.load();
      if (!this._text) this.text();
      if (!this.textGone) {   // les textes gênent la lecture des murs : on les retire avant le rendu
        const rm = [];
        const rec = (get, n, owner) => { for (let k = n - 1; k >= 0; k--) { const o = get(k); if (!o) continue; const t = M.FPDFPageObj_GetType(o); if (t === 1) rm.push([owner, o]); else if (t === 5) rec(j => M.FPDFFormObj_GetObject(o, j), M.FPDFFormObj_CountObjects(o), o); } };
        rec(k => M.FPDFPage_GetObject(this.h, k), M.FPDFPage_CountObjects(this.h), null);
        rm.forEach(([owner, o]) => { const ok = owner ? M.FPDFFormObj_RemoveObject(owner, o) : M.FPDFPage_RemoveObject(this.h, o); if (ok) M.FPDFPageObj_Destroy(o); });
        this.textGone = true;
      }
      if (this.W * this.H * s * s > maxPx) s = Math.sqrt(maxPx / (this.W * this.H));
      const w = Math.ceil(this.W * s), h = Math.ceil(this.H * s);
      const bmp = M.FPDFBitmap_Create(w, h, 0);
      M.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xFFFFFFFF);
      // 0x4000 sans lissage des tracés, 0x2000 des images, 0x1000 des textes : des couleurs franches pour les seuils
      M.FPDF_RenderPageBitmap(bmp, this.h, 0, 0, w, h, 0, 0x4000 | 0x2000 | 0x1000);
      const buf = M.FPDFBitmap_GetBuffer(bmp), stride = M.FPDFBitmap_GetStride(bmp), H8 = heap();
      const img = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y++) { let si = buf + y * stride, di = y * w * 3; for (let x = 0; x < w; x++, si += 4, di += 3) { img[di] = H8[si + 2]; img[di + 1] = H8[si + 1]; img[di + 2] = H8[si]; } }
      M.FPDFBitmap_Destroy(bmp);
      return { img, W: w, H: h, s };
    }
    close() { this.release(); }
  }
  function circum(a, b, c) {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])); if (Math.abs(d) < 1e-9) return null;
    const A2 = a[0] * a[0] + a[1] * a[1], B2 = b[0] * b[0] + b[1] * b[1], C2 = c[0] * c[0] + c[1] * c[1];
    return [(A2 * (b[1] - c[1]) + B2 * (c[1] - a[1]) + C2 * (a[1] - b[1])) / d, (A2 * (c[0] - b[0]) + B2 * (a[0] - c[0]) + C2 * (b[0] - a[0])) / d];
  }
  const angDiff = (p, q) => { let d = q - p; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  // PDFium coupe les textes en morceaux (« prestat » + « ion. ») : on recolle les morceaux contigus d'une même ligne
  function mergeRuns(items) {
    const groups = new Map();
    items.forEach(it => { const k = Math.round(it.ang * 20); (groups.get(k) || groups.set(k, []).get(k)).push(it); });
    const out = [];
    groups.forEach(L => {
      const a = L[0].ang, c = Math.cos(a), s = Math.sin(a);
      L.forEach(it => { const xs = [it.x0, it.x1], ys = [it.y0, it.y1], al = [], ac = []; xs.forEach(x => ys.forEach(y => { al.push(x * c + y * s); ac.push(-x * s + y * c); })); it._a0 = Math.min(...al); it._a1 = Math.max(...al); it._c = (Math.min(...ac) + Math.max(...ac)) / 2; });
      L.sort((p, q) => p._c - q._c || p._a0 - q._a0);
      const rows = [];
      L.forEach(it => { const r = rows.find(r => Math.abs(r.c - it._c) < 0.35 * Math.max(r.size, it.size) && Math.abs(r.size - it.size) < 0.25 * Math.max(r.size, it.size)); if (r) { r.items.push(it); } else rows.push({ c: it._c, size: it.size, items: [it] }); });
      rows.forEach(r => {
        r.items.sort((p, q) => p._a0 - q._a0);
        let cur = null;
        r.items.forEach(it => {
          const gap = cur ? it._a0 - cur._a1 : 1e9;
          // deux espaces ou plus en bord de morceau : séparation de colonnes, on ne recolle pas
          if (cur && cur.sp1 < 2 && it.sp0 < 2 && gap < 0.18 * it.size && gap > -0.4 * it.size) {
            const sep = (cur.sp1 || it.sp0 || gap > 0.12 * it.size) ? ' ' : '';
            cur.s += sep + it.s; cur.sp1 = it.sp1; cur.x0 = Math.min(cur.x0, it.x0); cur.y0 = Math.min(cur.y0, it.y0); cur.x1 = Math.max(cur.x1, it.x1); cur.y1 = Math.max(cur.y1, it.y1); cur._a1 = Math.max(cur._a1, it._a1); cur.size = Math.max(cur.size, it.size);
          } else { if (cur) out.push(cur); cur = Object.assign({}, it); }
        });
        if (cur) out.push(cur);
      });
    });
    out.forEach(it => { it.cx = (it.x0 + it.x1) / 2; it.cy = (it.y0 + it.y1) / 2; delete it._a0; delete it._a1; delete it._c; delete it.sp0; delete it.sp1; });
    return out;
  }
  // angle d'un texte à l'écran : direction de la ligne de base passée dans le repère d'affichage
  function screenAngle(T, m) { const dx = T[0] * m[0] + T[2] * m[1], dy = T[1] * m[0] + T[3] * m[1]; return Math.atan2(dy, dx); }

  // tracé → polylignes (les courbes de Bézier sont échantillonnées), pour l'analyse géométrique
  function polylines(p, step = 6) {
    const out = []; let cur = null, i = 0; const n = p.ty.length, X = k => p.pts[2 * k], Y = k => p.pts[2 * k + 1];
    while (i < n) {
      const t = p.ty[i] & 7;
      if (t === 2) { if (cur && cur.length > 1) out.push(cur); cur = [[X(i), Y(i)]]; i++; continue; }
      if (!cur) cur = [[X(i), Y(i)]];
      if (t === 0) { cur.push([X(i), Y(i)]); if (p.ty[i] & 8) { cur.closed = true; } i++; continue; }
      if (t === 1 && i + 2 < n) {
        const a = cur[cur.length - 1], b = [X(i), Y(i)], c = [X(i + 1), Y(i + 1)], d = [X(i + 2), Y(i + 2)];
        for (let k = 1; k <= step; k++) { const u = k / step, v = 1 - u; cur.push([v * v * v * a[0] + 3 * v * v * u * b[0] + 3 * v * u * u * c[0] + u * u * u * d[0], v * v * v * a[1] + 3 * v * v * u * b[1] + 3 * v * u * u * c[1] + u * u * u * d[1]]); }
        cur.curve = true; if (p.ty[i + 2] & 8) cur.closed = true; i += 3; continue;
      }
      i++;
    }
    if (cur && cur.length > 1) out.push(cur);
    return out;
  }

  const PDFE = { init, open, polylines, get ready() { return !!M; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = PDFE; else root.PDFE = PDFE;
})(typeof self !== 'undefined' ? self : this);

/* ---- m1_pdf.js ---- */
/* ==================================================================================================
   DCE Educ — m1_pdf : ouverture des PDF (PDFium), textes positionnés, classement des pièces du DCE
   ================================================================================================== */
'use strict';
const PDFX = (() => {
  const W_ = typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {});
  // PDFium : le module WebAssembly est chargé une fois (fichier pdfium.wasm à côté de l'appli, ou embarqué en base 64)
  let loading = null;
  async function ensure() {
    if (PDFE.ready) return;
    if (!loading) loading = (async () => {
      let bin;
      if (W_.__PDFIUM_WASM_B64) { const b = atob(W_.__PDFIUM_WASM_B64); bin = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) bin[i] = b.charCodeAt(i); }
      else bin = new Uint8Array(await (await fetch(W_.__PDFIUM_URL || 'pdfium.wasm')).arrayBuffer());
      await PDFE.init(bin, W_.PDFIUM_INIT);
    })();
    return loading;
  }
  const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

  // file : objet File du navigateur, ou { name, bytes } (essais sous Node)
  async function open(file) {
    await ensure();
    // (les navigateurs récents ont une méthode File.bytes() : on ne prend « bytes » que s'il contient déjà les octets)
    const data = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(await file.arrayBuffer());
    return PDFE.open(data);
  }

  // textes d'une page en coordonnées d'affichage (points, y vers le bas, rotation de page appliquée)
  async function pageText(page) { return page.text(); }

  // lignes de texte (pièces écrites) : regroupement par ordonnée, tri par abscisse
  function lines(items, tol = 2.5) {
    const hz = items.filter(t => Math.abs(t.ang) < 0.3).sort((p, q) => p.cy - q.cy || p.x0 - q.x0), L = [];
    for (const t of hz) {
      const l = L.length ? L[L.length - 1] : null;
      if (l && Math.abs(l.cy - t.cy) <= Math.max(tol, t.size * 0.35)) { l.items.push(t); l.cy = (l.cy * (l.items.length - 1) + t.cy) / l.items.length; }
      else L.push({ cy: t.cy, items: [t] });
    }
    L.forEach(l => { l.items.sort((p, q) => p.x0 - q.x0); l.x0 = l.items[0].x0; l.text = l.items.map(t => t.s).join(' ').replace(/\s+/g, ' ').trim(); l.size = Math.max(...l.items.map(t => t.size)); });
    return L;
  }

  // ------------------------------------------------------------- classement d'une page
  const AREA_RE = /^(\d{1,4}[.,]\d{1,2})\s*m\s*[²2]?$/i;
  function scaleOf(items) {
    const cand = [];
    items.forEach(t => {
      const m = t.s.match(/(?:^|\s|:)1\s*[:\/]\s*(10|20|25|50|75|100|125|150|200|250|500|1000|2000)\b/);
      if (m) cand.push({ v: +m[1], score: t.size + (/ech/i.test(t.s) ? 20 : 0) });
      const e = t.s.match(/^[ée]ch(?:elle)?\.?\s*:?\s*$/i);
      if (e) { const near = items.find(u => u !== t && Math.abs(u.cy - t.cy) < 30 && u.x0 > t.x0 && u.x0 - t.x1 < 200 && /1\s*[:\/]\s*\d+/.test(u.s)); if (near) { const mm = near.s.match(/1\s*[:\/]\s*(\d+)/); cand.push({ v: +mm[1], score: 50 }); } }
    });
    cand.sort((a, b) => b.score - a.score);
    return cand.length ? cand[0].v : null;
  }
  function levelOf(title) {
    const t = norm(title).replace(/\bR\s*\.\s*D\s*\.\s*C\b\.?/g, 'RDC').replace(/\bR\s*\.\s*\+/g, 'R+');
    let m;
    if ((m = t.match(/\bR\s*\+\s*(\d)\b/))) return { name: 'R+' + m[1], n: +m[1] };
    if ((m = t.match(/\b(\d)(?:ER|E|EME)\s*ETAGE\b/))) return { name: 'R+' + m[1], n: +m[1] };
    if (/\bR\s*-\s*1\b|SOUS[- ]SOL/.test(t)) return { name: 'R-1', n: -1 };
    if (/\bRDC\b|REZ[- ]DE[- ]CHAUSSEE/.test(t)) return { name: 'RDC', n: 0 };
    if (/COMBLE/.test(t)) return { name: 'Combles', n: 9 };
    if (/ETAGE/.test(t)) return { name: 'R+1', n: 1 };
    return null;
  }
  function altOf(title) { const m = title.match(/\(\s*([+-]?\s*\d{1,2}[.,]\d{2})\s*\)/); return m ? parseFloat(m[1].replace(/\s/g, '').replace(',', '.')) : null; }

  function classify(items, W, H, pageCount) {
    const big = Math.max(W, H) > 1000;                         // A3 et plus : pièce graphique
    const up = norm(items.map(t => t.s).join(' '));
    const areas = items.filter(t => AREA_RE.test(t.s)).length;
    // titre : les textes les plus gros du cartouche, puis le reste
    const bySize = items.slice().sort((a, b) => b.size - a.size);
    const titles = bySize.slice(0, 40).map(t => t.s);
    const titleTxt = titles.filter(s => /PLAN|COUPE|FACADE|FAÇADE|AXONO|PERSP|MASSE|SITUATION|INSERTION|JARDIN|INSTALLATION|NIVEAU|R\s*\+|RDC|REZ|ETAGE|ÉTAGE|SOUS/i.test(norm(s))).join(' | ');
    const T = norm(titleTxt);
    const res = { kind: 'autre', title: titleTxt.slice(0, 120), areas, scale: null, level: null, alt: null };
    if (!big) {
      if (/C\.?\s?C\.?\s?T\.?\s?P\b|CLAUSES TECHNIQUES PARTICULIERES/.test(up)) res.kind = 'cctp';
      else if (/D\.?\s?P\.?\s?G\.?\s?F\b|DECOMPOSITION DU PRIX GLOBAL|C\.?D\.?P\.?G\.?F|D\.?Q\.?E\b|DETAIL QUANTITATIF/.test(up)) res.kind = 'dpgf';
      const lm = up.match(/\bLOT\s*(?:N[°O]\.?\s*)?(\d{1,2}[A-Z]?)\b/);
      if (lm) res.lot = lm[1].padStart(2, '0');
      return res;
    }
    res.scale = scaleOf(items);
    if (/MASSE|SITUATION|JARDIN|AMENAGEMENT|AMÉNAGEMENT/.test(T) && !/ASSEMBLAGE/.test(T)) res.kind = 'masse';
    else if (/AXONO|PERSPECTIVE|INSERTION/.test(T)) res.kind = 'vue';
    else if (/INSTALLATION/.test(T)) res.kind = 'pic';
    else if (areas >= 5 && /PLAN|NIVEAU|R\s*\+|RDC|REZ|ETAGE/.test(T)) res.kind = 'plan';
    else if (/COUPE/.test(T) && areas < 5) res.kind = 'coupe';
    else if (/FACADE/.test(T)) res.kind = 'facade';
    else if (areas >= 5) res.kind = 'plan';
    if (res.kind === 'plan') {
      let lv = null; for (const s of titles) { if (/PLAN|NIVEAU|R\s*\+|R\.?D\.?C|REZ|ETAGE/i.test(norm(s)) && (lv = levelOf(s))) break; }
      lv = lv || levelOf(titleTxt) || levelOf(up.slice(0, 4000));
      res.level = lv; res.alt = altOf(titleTxt);
      res.partial = /ZONE|PARTIE|DETAIL|DÉTAIL/.test(T) && !/ASSEMBLAGE/.test(T);
      // un plan de petit bâtiment annexe (titre avec nom propre) : laissé à l'appréciation de l'élève
      if (/SALLE|LOCAL|ANNEXE|PREAU|PRÉAU/.test(T) && !/ASSEMBLAGE/.test(T) && areas < 8) res.kind = 'annexe';
    }
    if (pageCount > 1 && res.kind === 'autre' && /COUPE/.test(T)) res.kind = 'coupe';
    return res;
  }

  // classement d'une pièce : contenu de la 1re page, puis indices tirés du nom de fichier
  function classifyPiece(name, t, numPages) {
    const cls = classify(t.items, t.W, t.H, numPages);
    const fn = norm(name);
    if (cls.kind === 'plan') { if (/ZONE|PARTIE/.test(fn) && !/ASSEMBLAGE/.test(fn)) cls.partial = true; const lv = levelOf(name.replace(/[._]/g, ' ')); if (lv && (!cls.level || /ASSEMBLAGE|PLAN/.test(fn))) cls.level = lv; }
    if (!cls.lot) { const m = fn.match(/LOT\s*(\d{1,2})|CCTP\s*(\d{1,2})|DPGF\s*(?:LOT\s*)?(\d{1,2})/); if (m) cls.lot = (m[1] || m[2] || m[3]).padStart(2, '0'); }
    if (cls.kind === 'autre') {
      const hint = [[/C\.?C\.?T\.?P/, 'cctp'], [/D\.?P\.?G\.?F|D\.?Q\.?E/, 'dpgf'], [/INSTALLATION/, 'pic'], [/COUPE/, 'coupe'], [/FACADE/, 'facade'], [/AXONO|PERSPECTIVE|VUES?\b|INSERTION/, 'vue'], [/MASSE|SITUATION/, 'masse']].find(([re]) => re.test(fn));
      if (hint) cls.kind = hint[1];
    }
    // une feuille « façades » dont le titre ne dit rien (dessin en image) : le nom du fichier tranche
    if (cls.kind !== 'facade' && /FACADE/.test(fn) && !/INSERTION/.test(fn) && !/PLAN/.test(fn)) cls.kind = 'facade';
    if (cls.kind === 'facade' && /INSERTION/.test(fn)) cls.kind = 'vue';   // façades d'insertion : le bâtiment dans son site, pas une façade cotée
    return cls;
  }
  return { open, ensure, pageText, lines, classify, classifyPiece, norm, AREA_RE, levelOf, altOf };
})();

/* ---- m4_ecrits.js ---- */
/* ==================================================================================================
   DCE Educ — m4_ecrits : lecture du CCTP (lots, articles, localisations, références) et du DPGF
   ================================================================================================== */
'use strict';
const ECRITS = (() => {
  const norm = PDFX.norm;
  const REFS = [
    [/\bNF\s?DTU\s?\d{1,2}(?:[.,]\d{1,2})?(?:\s?P\s?\d)?/gi, 'DTU'], [/\bDTU\s?\d{1,2}(?:[.,]\d{1,2})?/gi, 'DTU'],
    [/\bNF\s?EN\s?\d{3,5}(?:-\d+)*/gi, 'Norme EN'], [/\bNF\s?P\s?\d{2}[-\s]?\d{3}/gi, 'Norme NF P'], [/\bNF\s?C\s?\d{2}[-\s]?\d{3}/gi, 'Norme NF C'],
    [/\bU\d\s?P\d\s?E\d\s?C\d\b/gi, 'Classement UPEC'], [/\bU\d[sS]?\s?P\d\b/g, 'Classement UPEC'],
    [/\b(?:EI|REI|RE|E)\s?\d{2,3}\b/g, 'Résistance au feu'], [/\b[A-E]\d?-s\d,?\s?d\d\b/g, 'Réaction au feu'], [/\bM[0-4]\b/g, 'Réaction au feu'],
    [/\bR\s?[=≥]\s?\d+[.,]?\d*\s?m[²2]\.?\s?K\/W/gi, 'Résistance thermique'], [/\bU[wf]?\s?[=≤<]\s?\d+[.,]\d+/g, 'Coefficient U'],
    [/\bR\s?A\s?,?\s?tr\s?[=≥]\s?\d+\s?dB|\bR'?w\s?\(?C\s?;?\s?Ctr\)?\s?[=≥]?\s?\d+\s?dB|\b\d{2}\s?dB\b/gi, 'Acoustique'],
    [/\bAEV\b|\bA\*?\d\s?E\*?\d\w?\s?V\*?A?\d\b/g, 'Classement AEV'], [/\bQ4\b|\bClasse\s?[1-4]\b/g, 'Classement']
  ];
  function refsOf(txt) {
    const out = new Map();
    for (const [re, kind] of REFS) { const m = txt.match(re); if (m) m.forEach(v => { const k = v.replace(/\s+/g, ' ').trim(); if (!out.has(k)) out.set(k, kind); }); }
    return [...out].map(([v, k]) => ({ v, k }));
  }

  // ------------------------------------------------------------------ CCTP
  async function readCCTP(doc, info, log = () => {}) {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) { const p = await doc.getPage(i); const t = await PDFX.pageText(p); if (p.release) p.release(); pages.push({ L: PDFX.lines(t.items, 2.2), H: t.H }); if (i % 20 === 0) log('CCTP : page ' + i + ' / ' + doc.numPages); }
    // en-têtes et pieds répétés
    const freq = new Map();
    pages.forEach(pg => { const seen = new Set(); pg.L.forEach(l => { if (l.cy > pg.H * 0.12 && l.cy < pg.H * 0.9) return; const k = l.text.replace(/\d+/g, '#'); if (!seen.has(k)) { seen.add(k); freq.set(k, (freq.get(k) || 0) + 1); } }); });
    const rep = new Set([...freq].filter(([k, v]) => v >= Math.max(3, pages.length * 0.4)).map(([k]) => k));
    let lot = info.lot || null, lotTitle = '';
    const all = [];
    pages.forEach((pg, pi) => pg.L.forEach(l => {
      const k = l.text.replace(/\d+/g, '#');
      if (rep.has(k) && (l.cy < pg.H * 0.12 || l.cy > pg.H * 0.9)) { const m = norm(l.text).match(/LOT\s*(?:N[°O]\.?\s*)?(\d{1,2}[A-Z]?)/); if (m && !lot) lot = m[1].padStart(2, '0'); return; }
      if (/\.{5,}|…{3,}|_{4,}/.test(l.text)) return;                // sommaire (points ou traits de conduite)
      all.push({ ...l, page: pi + 1 });
    }));
    // pages de sommaire : beaucoup de titres numérotés terminés par un numéro de page
    const tocPage = new Set();
    pages.forEach((pg, pi) => { const heads = all.filter(l => l.page === pi + 1 && /^\d{1,2}(\.\d{1,2})*\.?\s+\D/.test(l.text)); const withPg = heads.filter(l => /[A-Za-zÀ-ÿ)]\s*[:.]?\s+\d{1,3}\s*$/.test(l.text)); if (withPg.length >= 5 && withPg.length >= heads.length * 0.5) tocPage.add(pi + 1); });
    if (tocPage.size) { for (let i = all.length - 1; i >= 0; i--) if (tocPage.has(all[i].page)) all.splice(i, 1); }
    // titre du lot : texte fort de la première page
    const first = pages[0] ? pages[0].L.slice().sort((a, b) => b.size - a.size) : [];
    const tl = first.find(l => /LOT/i.test(l.text) && /[A-Za-z]{4,}/.test(l.text.replace(/LOT/i, '')));
    lotTitle = tl ? tl.text.replace(/.*LOT\s*(N[°o]\.?\s*)?\d{1,2}[A-Z]?\s*[-–:]*\s*/i, '').trim() : '';
    if (!lotTitle) { const i0 = first.findIndex(l => /^LOT\s*\d/i.test(l.text.trim())); if (i0 >= 0) { const nx = pages[0].L.find(l => l.cy > first[i0].cy && /[A-Za-z]{4,}/.test(l.text)); if (nx) lotTitle = nx.text; } }
    // articles
    const left = (() => { const xs = all.map(l => l.x0).sort((a, b) => a - b); return xs[Math.floor(xs.length * 0.1)] || 50; })();
    const arts = []; let cur = null;
    const AR = /^(\d{1,2}(?:\.\d{1,2}){1,5}|\d{1,2})\.?\s+(.{3,})$/;
    all.forEach(l => {
      const m = l.text.match(AR);
      const isHead = m && l.x0 < left + 60 && !/^\d+[.,]\d+\s*(m|cm|mm|kg|%|ml|m²)/i.test(l.text) && /[A-Za-zÀ-ÿ]{3,}/.test(m[2]) && m[2].length < 160 && !/^\d/.test(m[2]);
      if (isHead) { cur = { num: m[1], titre: m[2].replace(/\s+/g, ' ').trim(), lignes: [], page: l.page }; arts.push(cur); return; }
      if (cur) cur.lignes.push(l.text);
    });
    arts.forEach(a => {
      const txt = a.lignes.join('\n');
      const li = a.lignes.findIndex(x => /^\s*Localisation\s*:?/i.test(x));
      let loc = '';
      if (li >= 0) {
        const parts = [a.lignes[li].replace(/^\s*Localisation\s*:?\s*/i, '')];
        for (let k = li + 1; k < a.lignes.length && k < li + 14; k++) { const x = a.lignes[k]; if (/^\s*(Nota|NOTA|Mode de m[ée]tr|Prescriptions|Mise en oeuvre|Mise en œuvre|Ouvrages|Définition)\b/.test(x)) break; parts.push(x); }
        loc = parts.join(' ').replace(/\s+/g, ' ').replace(/^[►\-–•\s]+/, '').trim();
      }
      a.loc = loc; a.refs = refsOf(a.titre + '\n' + txt);
      a.texte = txt.replace(/\s+\n/g, '\n').slice(0, 1600);
      a.niveau = a.num.split('.').length;
      delete a.lignes;
    });
    // un même numéro lu deux fois (sommaire résiduel, renvoi) : on garde le plus fourni
    for (let i = arts.length - 1; i >= 0; i--) { const j = arts.findIndex(b => b.num === arts[i].num); if (j !== i) { const keep = (arts[i].texte || '').length >= (arts[j].texte || '').length ? i : j; arts.splice(keep === i ? j : i, 1); } }
    // feuilles : articles sans sous-article
    arts.forEach((a, i) => { a.feuille = !arts.some(b => b !== a && b.num.startsWith(a.num + '.')); });
    log('CCTP lot ' + (lot || '?') + ' : ' + arts.length + ' articles');
    return { lot: lot || '??', titre: lotTitle, articles: arts, pages: pages.length };
  }

  // ------------------------------------------------------------------ DPGF
  const UNITS = /^(m[²2]|m2|m[³3]|m3|ml|m|u|U|ens|ENS|Ens|ft|Ft|FT|fft|forfait|kg|t|h|pm|PM|unité|l)$/;
  async function readDPGF(doc, info, log = () => {}) {
    const rows = []; let lot = info.lot || null, titre = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i); const t = await PDFX.pageText(p); if (p.release) p.release();
      const L = PDFX.lines(t.items, 2.0);
      if (i === 1) { const big = L.slice().sort((a, b) => b.size - a.size); const k = big.findIndex(l => /^LOT\s*\d/i.test(l.text.trim())); if (k >= 0) { const nx = L.find(l => l.cy > big[k].cy && /[A-Za-z]{4,}/.test(l.text) && !/DECOMPOSITION|D\.P\.G\.F|CADRE/i.test(l.text)); if (nx) titre = nx.text.trim(); } }
      const lm = norm(L.map(l => l.text).join(' ')).match(/\bLOT\s*(?:N[°O]\.?\s*)?(\d{1,2}[A-Z]?)\b/); if (lm && !lot) lot = lm[1].padStart(2, '0');
      // colonnes : en-tête « U » et « Q »
      const hdr = t.items.find(it => /^(U|UNIT[EÉ]S?|Unit[eé]s?).?$/.test(it.s.trim())) ;
      const hq = t.items.find(it => /^Q(\s*Moe|\s*M\.?O\.?E\.?)?$|^QUANT|^Qté|^Quantit/i.test(it.s.trim()));
      if (!hdr && !rows.length) continue;
      const xU = hdr ? hdr.cx : null, xQ = hq ? hq.cx : null;
      const startY = hdr ? hdr.cy : 0;
      L.forEach(l => {
        if (l.cy <= startY + 2 && hdr) return;
        const its = l.items;
        const numIt = its[0] && /^\d{1,2}(\.\d{1,2}){0,5}$/.test(its[0].s.trim()) ? its[0] : null;
        let unit = null, q = null;
        its.forEach(it => {
          const s = it.s.trim();
          if (xU !== null && Math.abs(it.cx - xU) < 22 && UNITS.test(s)) unit = s;
          else if (UNITS.test(s.split(' ')[0]) && /\d/.test(s) && xU !== null && Math.abs(it.x0 - xU) < 30) { unit = s.split(' ')[0]; const mm = s.match(/(\d[\d\s]*[.,]?\d*)$/); if (mm) q = parseFloat(mm[1].replace(/\s/g, '').replace(',', '.')); }
          if (xQ !== null && Math.abs(it.cx - xQ) < 40 && /^\d[\d\s]*([.,]\d+)?$/.test(s)) q = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
          else if (xU !== null && it.x0 > xU + 4 && it.x0 < xU + 80 && /^\d[\d\s]*[.,]\d{1,3}$/.test(s) && q === null) q = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
        });
        const des = its.filter(it => it !== numIt && (xU === null || it.x1 < xU - 8)).map(it => it.s).join(' ').replace(/\s+/g, ' ').trim();
        if (/^(sous-?total|total|tva|arr[êe]t|montant)/i.test(des) || /SOUS-TOTAL|TOTAL LOT/i.test(des)) { rows.push({ kind: 'total', des }); return; }
        if (numIt && des) rows.push({ kind: 'art', num: numIt.s.trim(), des, u: unit, q, page: i });
        else if (!numIt && des && rows.length && rows[rows.length - 1].kind === 'art' && !unit && q === null && des.length < 140 && !/^Désignation/i.test(des)) rows[rows.length - 1].des += ' ' + des;
        else if (!numIt && des && (unit || q !== null)) rows.push({ kind: 'art', num: '', des, u: unit, q, page: i });
        else if (!des && (unit || q !== null)) {
          // unité / quantité décalée sur sa propre ligne : rattachée à la ligne d'article précédente sans valeur
          for (let k = rows.length - 1; k >= 0 && k >= rows.length - 4; k--) { const r = rows[k]; if (r.kind === 'art' && r.q === null && r.u === null) { r.u = unit; r.q = q; r.decale = true; break; } if (r.kind === 'art' && r.q === null && r.u && unit === r.u) { r.q = q; r.decale = true; break; } }
        }
      });
    }
    const lignes = rows.filter(r => r.kind === 'art').map(r => ({ num: r.num, des: r.des, u: r.u ? r.u.replace(/^m2$/, 'm²').replace(/^m3$/, 'm³').replace(/^(ENS|Ens)$/, 'ens').replace(/^(FT|Ft|fft|forfait)$/, 'ft').replace(/^U$/, 'u') : null, q: r.q, decale: !!r.decale }));
    log('DPGF lot ' + (lot || '?') + ' : ' + lignes.length + ' lignes');
    return { lot: lot || '??', titre, lignes };
  }
  return { readCCTP, readDPGF, refsOf };
})();

/* ---- m12_ifclib.js ---- */
/* ==================================================================================================
   DCE Educ — m12_ifclib : lecteur IFC repris de l’Atelier Maquette (même auteur, mêmes droits).
   Extrait automatiquement par outils/extraire_ifc.py : ne pas modifier ici, modifier l’Atelier.
   ================================================================================================== */
/* ---- analyseur STEP et unités (base de l’Atelier) ---- */
function ifcAnalyser(txt){
  /* la section DATA seule : l'en-tête ne nous apprend rien d'utile,
     sinon le nom du logiciel émetteur, qu'on garde pour le rapport */
  var emetteur = "";
  var mApp = /FILE_NAME\s*\([\s\S]*?\)\s*;/i.exec(txt);
  if(mApp){
    var chaines = mApp[0].match(/'((?:[^']|'')*)'/g) || [];
    if(chaines.length >= 6)
      emetteur = chaines[chaines.length - 2].replace(/^'|'$/g, "").replace(/''/g, "'");
  }
  var schema = "";
  var mSch = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(txt);
  if(mSch) schema = mSch[1];

  var iData = txt.indexOf("DATA;");
  var corps = iData >= 0 ? txt.slice(iData + 5) : txt;
  var iFin = corps.indexOf("ENDSEC;");
  if(iFin >= 0) corps = corps.slice(0, iFin);

  var E = {};          /* #id → {type, a:[arguments]} */
  var parType = {};    /* TYPE → [ids] */
  var n = corps.length, i = 0, nb = 0;

  function sauterBlancs(){
    while(i < n){
      var c = corps.charCodeAt(i);
      if(c === 32 || c === 9 || c === 10 || c === 13){ i++; continue; }
      /* les commentaires STEP peuvent tomber n'importe où */
      if(c === 47 && corps.charCodeAt(i+1) === 42){
        var f = corps.indexOf("*/", i + 2);
        i = f < 0 ? n : f + 2; continue;
      }
      break;
    }
  }
  function lireChaine(){
    /* on est sur l'apostrophe ouvrante ; '' est une apostrophe */
    var out = "";
    i++;
    while(i < n){
      var c = corps.charAt(i);
      if(c === "'"){
        if(corps.charAt(i+1) === "'"){ out += "'"; i += 2; continue; }
        i++; break;
      }
      out += c; i++;
    }
    /* les accents voyagent en \X2\00E9\X0\ dans les fichiers anciens */
    return ifcDecoder(out);
  }
  function lireListe(){
    var out = [];
    i++;                       /* la parenthèse ouvrante */
    for(;;){
      sauterBlancs();
      if(i >= n) break;
      var c = corps.charAt(i);
      if(c === ")"){ i++; break; }
      if(c === ","){ i++; continue; }
      out.push(lireValeur());
    }
    return out;
  }
  function lireValeur(){
    sauterBlancs();
    var c = corps.charAt(i);
    if(c === "'") return lireChaine();
    if(c === "(") return lireListe();
    if(c === "#"){
      var d = ++i;
      while(i < n && corps.charCodeAt(i) >= 48 && corps.charCodeAt(i) <= 57) i++;
      return {ref: +corps.slice(d, i)};
    }
    if(c === "$"){ i++; return null; }
    if(c === "*"){ i++; return "*"; }
    if(c === "."){
      var d2 = i++;
      while(i < n && corps.charAt(i) !== ".") i++;
      i++;
      return corps.slice(d2, i);        /* « .TRUE. », « .ELEMENT. » */
    }
    /* UN TYPE NOMMÉ : IFCLABEL('x'), IFCLENGTHMEASURE(3.) (9.79).
       On le lisait jusqu'à la prochaine virgule ou parenthèse : une chaîne qui contient l'une
       des deux — « Béton armé (C25/30), lissé » — coupait la lecture au milieu, et la
       parenthèse fermante du type refermait la liste qui le contenait. Il se lit maintenant
       comme une liste d'un élément : {t:"IFCLABEL", v:"x"}. */
    var c3 = corps.charCodeAt(i);
    if((c3 >= 65 && c3 <= 90) || (c3 >= 97 && c3 <= 122) || c3 === 95){
      var dn = i;
      while(i < n && /[A-Za-z0-9_]/.test(corps.charAt(i))) i++;
      var nomT = corps.slice(dn, i).toUpperCase();
      sauterBlancs();
      if(corps.charAt(i) === "("){
        var lv = lireListe();
        return {t:nomT, v:(lv.length === 1 ? lv[0] : lv)};
      }
      return nomT;
    }
    /* un nombre */
    var d3 = i;
    while(i < n && ",)".indexOf(corps.charAt(i)) < 0) i++;
    var brut = corps.slice(d3, i).trim();
    var v = parseFloat(brut);
    if(!isNaN(v) && /^[-+0-9.eE]+$/.test(brut)) return v;
    return brut;
  }

  while(i < n){
    sauterBlancs();
    if(i >= n) break;
    if(corps.charAt(i) !== "#"){ i++; continue; }
    var d = ++i;
    while(i < n && corps.charCodeAt(i) >= 48 && corps.charCodeAt(i) <= 57) i++;
    var id = +corps.slice(d, i);
    sauterBlancs();
    if(corps.charAt(i) !== "="){ continue; }
    i++;
    sauterBlancs();
    var d4 = i;
    while(i < n && /[A-Za-z0-9_]/.test(corps.charAt(i))) i++;
    var type = corps.slice(d4, i).toUpperCase();
    sauterBlancs();
    if(corps.charAt(i) !== "("){ continue; }
    var args = lireListe();
    /* le point-virgule de fin */
    while(i < n && corps.charAt(i) !== ";") i++;
    i++;
    E[id] = {id:id, type:type, a:args};
    (parType[type] || (parType[type] = [])).push(id);
    nb++;
  }
  return {E:E, parType:parType, nb:nb, emetteur:emetteur, schema:schema};
}

/* LES ACCENTS DES VIEUX FICHIERS.
   IFC2x3 encode les caractères non-ASCII en \X2\00E9\X0\ (UTF-16) ou
   \X\E9 (Latin-1). Sans ce décodage, « Séjour » arrive « S\X2\00E9\X0\jour »
   dans le nom des pièces, et le plan devient illisible. */
function ifcDecoder(s){
  /* LE FILTRE D'ENTRÉE DOIT ÊTRE LE BON.
     Il ne testait que « \X » : les noms encodés en « \S\ » — la forme
     la plus courante pour un seul caractère accentué — ressortaient
     intacts, et « Entrée » s'affichait « Entr\S\ie ». Toute chaîne qui
     contient une contre-oblique mérite d'être examinée. */
  if(s.indexOf("\\") < 0) return s;

  /* la forme normalisée : \X2\ suivi de codes UTF-16, terminé par \X0\ */
  s = s.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, function(_m, hex){
    var out = "";
    for(var k = 0; k + 4 <= hex.length; k += 4)
      out += String.fromCharCode(parseInt(hex.substr(k, 4), 16));
    return out;
  });
  /* LA FORME QUE LES EXPORTATEURS ÉCRIVENT VRAIMENT : \X\ suivi d'un
     nombre variable de chiffres hexadécimaux et refermé par \X\.
     Deux chiffres désignent un caractère Latin-1, quatre un caractère
     Unicode. L'exportateur de cette application écrit « \X\2014\ »
     pour un tiret cadratin, ce qui n'est pas la norme — mais c'est ce
     qu'il y a dans le fichier, et c'est lui qu'il faut lire. */
  s = s.replace(/\\X\\([0-9A-Fa-f]{2,8})\\/g, function(_m, hex){
    if(hex.length === 2 || hex.length === 4)
      return String.fromCharCode(parseInt(hex, 16));
    var out = "";
    for(var k = 0; k + 2 <= hex.length; k += 2)
      out += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
    return out;
  });
  /* la même, sans refermeture : deux chiffres exactement */
  s = s.replace(/\\X\\([0-9A-Fa-f]{2})/g, function(_m, hex){
    return String.fromCharCode(parseInt(hex, 16));
  });
  /* \S\c : le caractère c avec le bit de poids fort — « \S\i » vaut « é » */
  s = s.replace(/\\S\\(.)/g, function(_m, c){
    return String.fromCharCode(c.charCodeAt(0) + 128);
  });
  return s;
}

/* ---------------------------------------------------------------------
   30.2 · L'UNITÉ DE LONGUEUR
   Un fichier de Revit sort en millimètres, un fichier d'ArchiCAD peut
   sortir en mètres. Se tromper d'un facteur mille est l'erreur classique
   de l'import IFC — et elle ne se voit pas tout de suite : le plan est
   simplement « vide », parce qu'il fait quinze kilomètres de large.
   --------------------------------------------------------------------- */
var IFC_PREFIXES = {EXA:1e18, PETA:1e15, TERA:1e12, GIGA:1e9, MEGA:1e6,
  KILO:1e3, HECTO:1e2, DECA:10, DECI:0.1, CENTI:0.01, MILLI:1e-3,
  MICRO:1e-6, NANO:1e-9};

function ifcEchelle(P){
  var E = P.E;
  /* (9.79) L'UNITÉ ASSIGNÉE AU PROJET D'ABORD (IfcProject.UnitsInContext → IfcUnitAssignment) :
     c'est celle que le fichier déclare. À défaut, la première unité de longueur du fichier. Une
     unité CONVERTIE (pouce, pied) se lit désormais : son facteur est un type nommé, et l'ancien
     lecteur ne savait pas le rendre — tout fichier en pieds était pris pour des mètres. */
  var cand = [];
  (P.parType.IFCPROJECT || []).forEach(function(id){
    var pr = E[id], ua = pr && pr.a[8] && pr.a[8].ref ? E[pr.a[8].ref] : null;
    if(ua && ua.a[0] && ua.a[0].forEach)
      ua.a[0].forEach(function(r){ if(r && r.ref && E[r.ref]) cand.push(E[r.ref]); });
  });
  ["IFCSIUNIT", "IFCCONVERSIONBASEDUNIT"].forEach(function(t){
    (P.parType[t] || []).forEach(function(id){ cand.push(E[id]); });
  });
  for(var k = 0; k < cand.length; k++){
    var u = cand[k];
    if(!u || String(u.a[1]) !== ".LENGTHUNIT.") continue;
    if(u.type === "IFCSIUNIT"){
      var pref = String(u.a[2] || "").replace(/\./g, "");
      var f = IFC_PREFIXES[pref] || 1;
      return {m:f, nom:(pref ? pref.toLowerCase() : "") + "mètre"};
    }
    if(u.type === "IFCCONVERSIONBASEDUNIT"){
      var mu = u.a[3] && u.a[3].ref ? E[u.a[3].ref] : null;      /* IFCMEASUREWITHUNIT */
      var val = mu ? mu.a[0] : null;
      if(val && typeof val === "object") val = val.v;
      if(typeof val === "number"){
        var base = mu.a[1] && mu.a[1].ref ? E[mu.a[1].ref] : null, fb = 1;
        if(base && base.type === "IFCSIUNIT"){ var pb = String(base.a[2] || "").replace(/\./g, ""); fb = IFC_PREFIXES[pb] || 1; }
        return {m:val*fb, nom:String(u.a[2] || "unité convertie")};
      }
    }
  }
  return {m:1, nom:"mètre (supposé)"};
}

/* ---------------------------------------------------------------------
   30.3 · LES PLACEMENTS
   Chaque objet IFC est posé dans le repère de son parent, lui-même posé
   dans le repère du sien, et ainsi de suite jusqu'au projet. Résoudre
   cette chaîne est l'essentiel du travail : sans elle, tous les murs se
   superposent à l'origine.

   On ne garde que ce qui nous sert : une translation, une rotation
   autour de Z, et l'altitude. Un bâtiment penché n'existe pas ici.
   --------------------------------------------------------------------- */
/* ---- données des éléments (module 106) ---- */
var IFC_CLASSES_NOMS = (function(){
  var l = ("IfcWall IfcWallStandardCase IfcWallElementedCase IfcSlab IfcSpace IfcWindow IfcDoor IfcColumn IfcBeam " +
    "IfcStair IfcStairFlight IfcRamp IfcRampFlight IfcRailing IfcCurtainWall IfcCovering IfcRoof IfcFooting IfcPile " +
    "IfcMember IfcPlate IfcBuildingElementProxy IfcFurnishingElement IfcFurniture IfcOpeningElement IfcElementAssembly " +
    "IfcFlowTerminal IfcFlowSegment IfcFlowFitting IfcFlowController IfcFlowMovingDevice IfcFlowStorageDevice " +
    "IfcFlowTreatmentDevice IfcEnergyConversionDevice IfcDistributionElement IfcDistributionFlowElement " +
    "IfcDistributionControlElement IfcDistributionChamberElement IfcSanitaryTerminal IfcLightFixture IfcElectricAppliance " +
    "IfcTransportElement IfcAnnotation IfcGrid IfcSite IfcBuilding IfcBuildingStorey IfcProject IfcSystem IfcZone " +
    "IfcReinforcingBar IfcReinforcingMesh IfcTendon IfcDiscreteAccessory IfcMechanicalFastener IfcFastener " +
    "IfcGeographicElement IfcCivilElement IfcVirtualElement IfcProxy IfcSensor IfcActuator IfcAlarm IfcController " +
    "IfcPipeSegment IfcPipeFitting IfcDuctSegment IfcDuctFitting IfcCableCarrierSegment IfcCableSegment IfcValve " +
    "IfcAirTerminal IfcElectricDistributionBoard IfcOutlet IfcSwitchingDevice IfcTank IfcBoiler IfcPump IfcFan").split(" ");
  var m = {};
  l.forEach(function(n){ m[n.toUpperCase()] = n; });
  return m;
})();
function ifcNomClasse(t){ return IFC_CLASSES_NOMS[t] || t; }

/* les classes qui NE SONT PAS des ouvrages à compter : les vides, les repères, les annotations */
var IFC_CLASSES_NEUTRES = {IFCOPENINGELEMENT:1, IFCGRID:1, IFCANNOTATION:1, IFCVIRTUALELEMENT:1, IFCSITE:1,
  IFCBUILDING:1, IFCBUILDINGSTOREY:1, IFCPROJECT:1};

/* ---- les unités : tout est ramené au système international ---- */
function ifcFacteurUnite(P, u){
  /* facteur qui ramène une valeur de l'unité du fichier à l'unité SI de base
     (m, m², m³, kg, rad). Un fichier en millimètres écrit 2200 pour 2,20 m. */
  if(!u) return 1;
  var E = P.E;
  if(u.type === "IFCSIUNIT"){
    var pref = String(u.a[2] || "").replace(/\./g, ""), f = IFC_PREFIXES[pref] || 1;
    var nom = String(u.a[3] || "");
    if(/SQUARE/.test(nom)) f = f*f;
    else if(/CUBIC/.test(nom)) f = f*f*f;
    if(/GRAM/.test(nom)) f = f/1000;          /* KILO + GRAM = 1 : le kilogramme est l'unité de base */
    return f;
  }
  if(u.type === "IFCCONVERSIONBASEDUNIT"){
    var mu = u.a[3] && u.a[3].ref ? E[u.a[3].ref] : null;      /* IfcMeasureWithUnit(valeur, unité) */
    if(mu){
      var v = mu.a[0];
      if(v && typeof v === "object") v = v.v;
      var base = mu.a[1] && mu.a[1].ref ? E[mu.a[1].ref] : null;
      if(typeof v === "number") return v * (base ? ifcFacteurUnite(P, base) : 1);
    }
  }
  return 1;
}
function ifcUnitesProjet(P){
  /* les unités ASSIGNÉES au projet (IfcProject.UnitsInContext → IfcUnitAssignment) :
     c'est ce que le fichier déclare, et non « la première unité de longueur
     qui passe » — un fichier peut en déclarer plusieurs. */
  var E = P.E, U = {L:1, A:1, V:1, M:1, ang:1, trouve:false};
  var liste = [];
  (P.parType.IFCPROJECT || []).forEach(function(id){
    var pr = E[id], ua = pr && pr.a[8] && pr.a[8].ref ? E[pr.a[8].ref] : null;
    if(ua && ua.a[0]) ua.a[0].forEach(function(r){ if(r && r.ref && E[r.ref]) liste.push(E[r.ref]); });
  });
  if(!liste.length){
    ["IFCSIUNIT", "IFCCONVERSIONBASEDUNIT"].forEach(function(t){
      (P.parType[t] || []).forEach(function(id){ liste.push(E[id]); });
    });
  }
  var vu = {};
  liste.forEach(function(u){
    if(!u) return;
    var type = String(u.type === "IFCSIUNIT" ? u.a[1] : u.a[1]);
    if(vu[type]) return;
    vu[type] = true;
    var f = ifcFacteurUnite(P, u);
    if(type === ".LENGTHUNIT."){ U.L = f; U.trouve = true; }
    else if(type === ".AREAUNIT.") U.A = f;
    else if(type === ".VOLUMEUNIT.") U.V = f;
    else if(type === ".MASSUNIT.") U.M = f;
    else if(type === ".PLANEANGLEUNIT.") U.ang = f;
  });
  return U;
}

/* ---- les mesures typées : IFCLENGTHMEASURE(2.2), IFCLABEL('Béton') … ---- */
var IFC_MESURES = {
  LENGTHMEASURE:["L", "m"], POSITIVELENGTHMEASURE:["L", "m"], NONNEGATIVELENGTHMEASURE:["L", "m"],
  AREAMEASURE:["A", "m²"], VOLUMEMEASURE:["V", "m³"], MASSMEASURE:["M", "kg"],
  PLANEANGLEMEASURE:["ang", "°"], POSITIVEPLANEANGLEMEASURE:["ang", "°"],
  THERMALTRANSMITTANCEMEASURE:[null, "W/(m²·K)"], THERMALCONDUCTIVITYMEASURE:[null, "W/(m·K)"],
  THERMALRESISTANCEMEASURE:[null, "m²·K/W"], POWERMEASURE:[null, "W"], ELECTRICCURRENTMEASURE:[null, "A"],
  ELECTRICVOLTAGEMEASURE:[null, "V"], FREQUENCYMEASURE:[null, "Hz"], THERMODYNAMICTEMPERATUREMEASURE:[null, "K"],
  VOLUMETRICFLOWRATEMEASURE:[null, "m³/s"], MASSDENSITYMEASURE:[null, "kg/m³"], HEATFLUXDENSITYMEASURE:[null, "W/m²"],
  SOUNDPRESSUREMEASURE:[null, "Pa"], PRESSUREMEASURE:[null, "Pa"], FORCEMEASURE:[null, "N"], ENERGYMEASURE:[null, "J"],
  ILLUMINANCEMEASURE:[null, "lx"], LUMINOUSFLUXMEASURE:[null, "lm"], TIMEMEASURE:[null, "s"], SPEEDMEASURE:[null, "m/s"]
};
/* un nombre pour l'affichage : pas de bruit numérique (1.8766236055674168E-26 → 0) */
function ifcNettoyerNombre(v){
  if(typeof v !== "number" || !isFinite(v)) return v;
  if(Math.abs(v) < 1e-9) return 0;
  var r = Math.round(v*1e6)/1e6;
  return r;
}
function ifcValeur(x, U){
  /* → [valeur, unité] — valeur : nombre, texte, booléen ou null */
  if(x === null || x === undefined || x === "*") return [null, ""];
  if(typeof x === "number") return [ifcNettoyerNombre(x), ""];
  if(typeof x === "string"){
    if(x === ".T.") return [true, ""];
    if(x === ".F.") return [false, ""];
    if(x === ".U.") return [null, ""];
    if(/^\.[A-Z0-9_]+\.$/.test(x)) return [x.slice(1, -1), ""];        /* énumération : .STANDARD. */
    return [x, ""];
  }
  if(Array.isArray(x)){
    var parts = [];
    x.forEach(function(y){ var r = ifcValeur(y, U); if(r[0] !== null && r[0] !== "") parts.push(r[0] === true ? "oui" : r[0] === false ? "non" : r[0]); });
    return [parts.length ? parts.join(" ; ") : null, ""];
  }
  if(x.ref) return [null, ""];
  if(x.t){
    var t = String(x.t).replace(/^IFC/, ""), v = x.v;
    if(Array.isArray(v)) return ifcValeur(v, U);
    if(t === "BOOLEAN" || t === "LOGICAL"){
      if(v === ".T." || v === true) return [true, ""];
      if(v === ".F." || v === false) return [false, ""];
      return [null, ""];
    }
    var mes = IFC_MESURES[t];
    if(typeof v === "number"){
      if(mes){
        var f = mes[0] && U && typeof U[mes[0]] === "number" ? U[mes[0]] : 1;
        var val = v*f;
        if(mes[0] === "ang") val = val*180/Math.PI;        /* radians → degrés, pour l'élève */
        return [ifcNettoyerNombre(val), mes[1]];
      }
      return [ifcNettoyerNombre(v), ""];
    }
    var r2 = ifcValeur(v, U);
    return [r2[0], r2[1]];
  }
  return [null, ""];
}

/* ---- une propriété, une quantité : → lignes [nom, valeur, unité] ---- */
function ifcLignesPropriete(P, ref, U, out, pref){
  var E = P.E, p = ref && ref.ref ? E[ref.ref] : null;
  if(!p) return;
  var nom = (typeof p.a[0] === "string") ? p.a[0] : "";
  if(pref) nom = pref + " › " + nom;
  var t = p.type, r;
  if(t === "IFCPROPERTYSINGLEVALUE"){
    r = ifcValeur(p.a[2], U);
    if(r[0] !== null && r[0] !== "") out.push([nom, r[0], r[1]]);
  } else if(t === "IFCPROPERTYENUMERATEDVALUE" || t === "IFCPROPERTYLISTVALUE"){
    r = ifcValeur(p.a[2], U);
    if(r[0] !== null && r[0] !== "") out.push([nom, r[0], r[1]]);
  } else if(t === "IFCPROPERTYBOUNDEDVALUE"){
    var hi = ifcValeur(p.a[2], U), lo = ifcValeur(p.a[3], U);
    var txt = (lo[0] !== null ? lo[0] : "…") + " à " + (hi[0] !== null ? hi[0] : "…");
    if(lo[0] !== null || hi[0] !== null) out.push([nom, txt, hi[1] || lo[1]]);
  } else if(t === "IFCCOMPLEXPROPERTY"){
    (p.a[3] || []).forEach(function(x){ ifcLignesPropriete(P, x, U, out, nom); });
  } else if(t === "IFCPROPERTYREFERENCEVALUE"){
    var cible = p.a[3] && p.a[3].ref ? E[p.a[3].ref] : null;
    if(cible && typeof cible.a[0] === "string" && cible.a[0]) out.push([nom, cible.a[0], ""]);
  } else if(t.indexOf("IFCQUANTITY") === 0){
    var v = p.a[3];
    if(typeof v !== "number") return;
    var u = "", f = 1;
    if(t === "IFCQUANTITYLENGTH"){ f = U.L; u = "m"; }
    else if(t === "IFCQUANTITYAREA"){ f = U.A; u = "m²"; }
    else if(t === "IFCQUANTITYVOLUME"){ f = U.V; u = "m³"; }
    else if(t === "IFCQUANTITYWEIGHT"){ f = U.M; u = "kg"; }
    else if(t === "IFCQUANTITYTIME"){ u = "s"; }
    else if(t === "IFCQUANTITYCOUNT"){ u = ""; }
    out.push([nom, ifcNettoyerNombre(v*f), u]);
  }
}
function ifcLireDefinition(P, id, U){
  var s = P.E[id];
  if(!s) return null;
  var nom, liste, quant = false;
  if(s.type === "IFCPROPERTYSET"){ nom = s.a[2]; liste = s.a[4]; }
  else if(s.type === "IFCELEMENTQUANTITY"){ nom = s.a[2]; liste = s.a[5]; quant = true; }
  else return null;
  var out = [];
  (liste || []).forEach(function(r){ ifcLignesPropriete(P, r, U, out, ""); });
  if(!out.length) return null;
  return {nom:(typeof nom === "string" && nom) ? nom : "(sans nom)", q:quant, l:out};
}

/* ---- les relations utiles aux données, indexées UNE fois ---- */
function ifcIndexDonnees(P){
  var E = P.E, defs = {}, typeDe = {}, mat = {}, classif = {}, parent = {};
  function ref(x){ return x && x.ref ? x.ref : null; }
  (P.parType.IFCRELDEFINESBYPROPERTIES || []).forEach(function(id){
    var r = E[id], objs = r.a[4], d = r.a[5];
    var defsIds = [];
    if(Array.isArray(d)) d.forEach(function(x){ if(ref(x)) defsIds.push(ref(x)); });
    else if(ref(d)) defsIds.push(ref(d));
    if(!objs || !defsIds.length) return;
    objs.forEach(function(o){
      var k = ref(o); if(k === null) return;
      var l = defs[k] || (defs[k] = []);
      defsIds.forEach(function(q){ l.push(q); });
    });
  });
  (P.parType.IFCRELDEFINESBYTYPE || []).forEach(function(id){
    var r = E[id], objs = r.a[4], t = ref(r.a[5]);
    if(!objs || t === null) return;
    objs.forEach(function(o){ var k = ref(o); if(k !== null) typeDe[k] = t; });
  });
  (P.parType.IFCRELASSOCIATESMATERIAL || []).forEach(function(id){
    var r = E[id], objs = r.a[4], m = ref(r.a[5]);
    if(!objs || m === null) return;
    objs.forEach(function(o){ var k = ref(o); if(k !== null) mat[k] = m; });
  });
  (P.parType.IFCRELASSOCIATESCLASSIFICATION || []).forEach(function(id){
    var r = E[id], objs = r.a[4], c = ref(r.a[5]);
    if(!objs || c === null) return;
    objs.forEach(function(o){ var k = ref(o); if(k !== null) (classif[k] || (classif[k] = [])).push(c); });
  });
  (P.parType.IFCRELAGGREGATES || []).forEach(function(id){
    var r = E[id], pere = ref(r.a[4]), fils = r.a[5];
    if(pere === null || !fils) return;
    fils.forEach(function(o){ var k = ref(o); if(k !== null) parent[k] = pere; });
  });
  return {defs:defs, typeDe:typeDe, mat:mat, classif:classif, parent:parent};
}

/* ---- les matériaux : une liste de couches [nom, épaisseur en m] ---- */
function ifcMateriaux(P, ref, U){
  var E = P.E, M = ref ? E[ref] : null, res = {nom:"", c:[]};
  if(!M) return res;
  function nomMat(r){ var x = r && r.ref ? E[r.ref] : null; return x && typeof x.a[0] === "string" ? x.a[0] : ""; }
  function couches(listRefs){
    (listRefs || []).forEach(function(r){
      var L = r && r.ref ? E[r.ref] : null;
      if(!L) return;
      if(L.type === "IFCMATERIALLAYER"){
        var n = nomMat(L.a[0]) || (typeof L.a[3] === "string" ? L.a[3] : "");
        var e = typeof L.a[1] === "number" ? ifcNettoyerNombre(L.a[1]*U.L) : null;
        if(n || e !== null) res.c.push(e !== null ? [n, e] : [n]);
      } else if(L.type === "IFCMATERIAL"){
        if(typeof L.a[0] === "string") res.c.push([L.a[0]]);
      } else if(L.type === "IFCMATERIALCONSTITUENT"){
        var n2 = nomMat(L.a[2]) || (typeof L.a[0] === "string" ? L.a[0] : "");
        if(n2) res.c.push([n2]);
      } else if(L.type === "IFCMATERIALPROFILE"){
        var n3 = nomMat(L.a[2]) || (typeof L.a[0] === "string" ? L.a[0] : "");
        if(n3) res.c.push([n3]);
      }
    });
  }
  var t = M.type;
  if(t === "IFCMATERIAL"){ if(typeof M.a[0] === "string") res.c.push([M.a[0]]); }
  else if(t === "IFCMATERIALLAYERSETUSAGE"){
    var S1 = M.a[0] && M.a[0].ref ? E[M.a[0].ref] : null;
    if(S1){ couches(S1.a[0]); if(typeof S1.a[1] === "string") res.nom = S1.a[1]; }
  } else if(t === "IFCMATERIALLAYERSET"){ couches(M.a[0]); if(typeof M.a[1] === "string") res.nom = M.a[1]; }
  else if(t === "IFCMATERIALLIST"){ couches(M.a[0]); }
  else if(t === "IFCMATERIALCONSTITUENTSET"){ couches(M.a[2]); if(typeof M.a[0] === "string") res.nom = M.a[0]; }
  else if(t === "IFCMATERIALPROFILESET" || t === "IFCMATERIALPROFILESETUSAGE"){
    var S2 = t === "IFCMATERIALPROFILESETUSAGE" ? (M.a[0] && M.a[0].ref ? E[M.a[0].ref] : null) : M;
    if(S2){ couches(S2.a[2]); if(typeof S2.a[0] === "string") res.nom = S2.a[0]; }
  } else if(t === "IFCMATERIALLAYER"){ couches([{ref:M.id}]); }
  return res;
}

/* ---- la classification : [système, code, libellé] ---- */
function ifcClassifications(P, ids){
  var E = P.E, out = [];
  (ids || []).forEach(function(id){
    var c = E[id];
    if(!c) return;
    if(c.type === "IFCCLASSIFICATIONREFERENCE"){
      var code = typeof c.a[1] === "string" ? c.a[1] : "", lib = typeof c.a[2] === "string" ? c.a[2] : "";
      var src = c.a[3] && c.a[3].ref ? E[c.a[3].ref] : null, sys = "";
      if(src && src.type === "IFCCLASSIFICATION") sys = typeof src.a[3] === "string" && src.a[3] ? src.a[3] : (typeof src.a[0] === "string" ? src.a[0] : "");
      if(code || lib) out.push([sys, code, lib]);
    } else if(c.type === "IFCCLASSIFICATION"){
      var s2 = typeof c.a[3] === "string" && c.a[3] ? c.a[3] : (typeof c.a[0] === "string" ? c.a[0] : "");
      if(s2) out.push([s2, "", ""]);
    }
  });
  return out;
}

/* le type prédéfini d'une classe courante (IFC4 : après les attributs de la classe) */
var IFC_PREDEFINI = {IFCWALL:8, IFCWALLSTANDARDCASE:8, IFCSLAB:8, IFCCOLUMN:8, IFCBEAM:8, IFCROOF:8, IFCRAILING:8,
  IFCCOVERING:8, IFCFOOTING:8, IFCPILE:8, IFCMEMBER:8, IFCPLATE:8, IFCSTAIR:8, IFCSTAIRFLIGHT:12, IFCRAMP:8,
  IFCDOOR:10, IFCWINDOW:10, IFCSPACE:9, IFCBUILDINGELEMENTPROXY:8, IFCCURTAINWALL:8};

function ifcTexte(x){ return (typeof x === "string") ? x.trim() : ""; }

/* ---------------------------------------------------------------------
   106.1b · LA FICHE D'UN ÉLÉMENT
   --------------------------------------------------------------------- */
function ifcPoolNeuf(){
  var m = {}, t = [];
  return {t:t, mot:function(s){
    s = String(s);
    var k = "$" + s, i = m[k];
    if(i === undefined){ i = t.length; t.push(s); m[k] = i; }
    return i;
  }};
}
function ifcCodeDefinitions(P, ids, U, pool, cache){
  /* [[mot(jeu), [[mot(nom), valeur, mot(unité)?], …]], …] — propriétés d'un côté, quantités de l'autre */
  var p = [], q = [], vus = {};
  (ids || []).forEach(function(id){
    if(vus[id]) return;
    vus[id] = true;
    var d = cache[id];
    if(d === undefined) d = cache[id] = ifcLireDefinition(P, id, U);
    if(!d) return;
    var lignes = d.l.map(function(L){
      var r = [pool.mot(L[0]), L[1]];
      if(L[2]) r.push(pool.mot(L[2]));
      return r;
    });
    (d.q ? q : p).push([pool.mot(d.nom), lignes]);
  });
  return {p:p, q:q};
}
function ifcFicheElement(P, id, ctx){
  var e = P.E[id], a = e.a, I = ctx.I, U = ctx.U, pool = ctx.pool;
  var f = {c:ifcNomClasse(e.type), g:ifcTexte(a[0]), n:ifcTexte(a[2])};
  var d = ifcTexte(a[3]); if(d) f.d = d;
  var o = ifcTexte(a[4]); if(o && o !== f.n) f.o = o;
  if(e.type === "IFCSPACE"){ var ln = ifcTexte(a[7]); if(ln) f.l = ln; }
  else { var tg = ifcTexte(a[7]); if(tg) f.t = tg; }
  var ip = IFC_PREDEFINI[e.type];
  if(ip !== undefined && typeof a[ip] === "string" && /^\.[A-Z0-9_]+\.$/.test(a[ip]) && a[ip] !== ".NOTDEFINED." && a[ip] !== ".USERDEFINED.")
    f.pd = a[ip].slice(1, -1);
  var t = I.typeDe[id];
  if(t) f.ty = t;
  var c = ifcCodeDefinitions(P, I.defs[id], U, pool, ctx.cache);
  if(c.p.length) f.p = c.p;
  if(c.q.length) f.q = c.q;
  var mid = I.mat[id];
  if(mid === undefined && I.parent[id] !== undefined) mid = I.mat[I.parent[id]];
  if(mid !== undefined){
    var M = ifcMateriaux(P, mid, U);
    if(M.c.length) f.m = M.c;
    if(M.nom) f.ms = M.nom;
  }
  var k = ifcClassifications(P, I.classif[id]);
  if(k.length) f.k = k;
  return f;
}
function ifcFicheType(P, tid, ctx){
  var e = P.E[tid];
  if(!e) return null;
  var a = e.a, I = ctx.I;
  var f = {c:ifcNomClasse(e.type), g:ifcTexte(a[0]), n:ifcTexte(a[2])};
  var d = ifcTexte(a[3]); if(d) f.d = d;
  var tg = ifcTexte(a[7]); if(tg) f.t = tg;
  var ids = [];
  (a[5] || []).forEach(function(r){ if(r && r.ref) ids.push(r.ref); });
  var c = ifcCodeDefinitions(P, ids, ctx.U, ctx.pool, ctx.cache);
  if(c.p.length) f.p = c.p;
  if(c.q.length) f.q = c.q;
  var mid = I.mat[tid];
  if(mid !== undefined){
    var M = ifcMateriaux(P, mid, ctx.U);
    if(M.c.length) f.m = M.c;
    if(M.nom) f.ms = M.nom;
  }
  return f;
}


/* ---- géométrie (module 107, 107.1 à 107.5d) ---- */
/* ---------------------------------------------------------------------
   107.1 · LES REPÈRES : matrices 3 × 4
   [Xx,Xy,Xz, Yx,Yy,Yz, Zx,Zy,Zz, Ox,Oy,Oz] — les trois axes, puis l'origine.
   --------------------------------------------------------------------- */
var IG_ID = [1,0,0, 0,1,0, 0,0,1, 0,0,0];
function igMul(A, B){
  var r = new Array(12), c, i;
  for(c = 0; c < 3; c++) for(i = 0; i < 3; i++)
    r[c*3 + i] = A[i]*B[c*3] + A[3 + i]*B[c*3 + 1] + A[6 + i]*B[c*3 + 2];
  for(i = 0; i < 3; i++) r[9 + i] = A[i]*B[9] + A[3 + i]*B[10] + A[6 + i]*B[11] + A[9 + i];
  return r;
}
function igApp(M, x, y, z){
  return [M[0]*x + M[3]*y + M[6]*z + M[9], M[1]*x + M[4]*y + M[7]*z + M[10], M[2]*x + M[5]*y + M[8]*z + M[11]];
}
function igDet(M){
  return M[0]*(M[4]*M[8] - M[5]*M[7]) - M[3]*(M[1]*M[8] - M[2]*M[7]) + M[6]*(M[1]*M[5] - M[2]*M[4]);
}
function igInv(M){
  var d = igDet(M);
  if(!(Math.abs(d) > 1e-15)) return IG_ID.slice();
  var a = M[0], b = M[3], c = M[6], e = M[1], f = M[4], g = M[7], h = M[2], k = M[5], l = M[8];
  var R = [ (f*l - g*k)/d, -(e*l - g*h)/d, (e*k - f*h)/d,
           -(b*l - c*k)/d,  (a*l - c*h)/d, -(a*k - b*h)/d,
            (b*g - c*f)/d, -(a*g - c*e)/d,  (a*f - b*e)/d ];
  /* R est rangée par colonnes comme M : R[c*3+i] = (M⁻¹)[i][c] */
  var t = [M[9], M[10], M[11]];
  return [R[0], R[1], R[2], R[3], R[4], R[5], R[6], R[7], R[8],
          -(R[0]*t[0] + R[3]*t[1] + R[6]*t[2]), -(R[1]*t[0] + R[4]*t[1] + R[7]*t[2]), -(R[2]*t[0] + R[5]*t[1] + R[8]*t[2])];
}
function igNorm(v){
  var L = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  return L > 1e-12 ? [v[0]/L, v[1]/L, v[2]/L] : null;
}
function igCroix(a, b){ return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]]; }
function igDot(a, b){ return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

/* ---------------------------------------------------------------------
   107.2 · LE CONTEXTE DE LECTURE
   Toutes les longueurs passent en MÈTRES dès la lecture : le calcul des
   solides travaille alors avec une tolérance qui a un sens (1/100 mm).
   --------------------------------------------------------------------- */
function igContexte(P){
  var U = ifcEchelle(P);
  var c = {P:P, E:P.E, m:U.m || 1, ang:igFacteurAngle(P), pl:{}, ax:{}, cv:{}, pf:{}, it:{},
           styles:null, matCoul:null, stats:{lus:0, nonLus:{}, csg:0, csgEchecs:0, tri:0}};
  return c;
}
/* l'unité d'angle plan : un arc de cercle « coupé » par paramètre se lit dans cette unité */
function igFacteurAngle(P){
  var E = P.E, out = 1, vu = false;
  (P.parType.IFCPROJECT || []).forEach(function(id){
    var pr = E[id], ua = pr && pr.a[8] && pr.a[8].ref ? E[pr.a[8].ref] : null;
    if(!ua || !ua.a[0] || !ua.a[0].forEach) return;
    ua.a[0].forEach(function(r){
      var u = r && r.ref ? E[r.ref] : null;
      if(!u || String(u.a[1]) !== ".PLANEANGLEUNIT." || vu) return;
      vu = true;
      if(u.type === "IFCCONVERSIONBASEDUNIT"){
        var mu = u.a[3] && u.a[3].ref ? E[u.a[3].ref] : null, v = mu ? mu.a[0] : null;
        if(v && typeof v === "object") v = v.v;
        out = (typeof v === "number" && v > 0) ? v : Math.PI/180;
        if(/DEGRE/i.test(String(u.a[2] || "")) && !(out > 0.01 && out < 0.02)) out = Math.PI/180;
      }
    });
  });
  return out;
}
function igNum(x){ if(x && typeof x === "object" && x.v !== undefined) x = x.v; return (typeof x === "number" && isFinite(x)) ? x : 0; }
function igEnt(c, ref){ return (ref && ref.ref) ? c.E[ref.ref] : null; }
function igPoint(c, ref){
  var o = igEnt(c, ref);
  if(!o || !o.a[0] || !o.a[0].length) return [0, 0, 0];
  var a = o.a[0];
  return [igNum(a[0])*c.m, igNum(a[1])*c.m, (a.length > 2 ? igNum(a[2]) : 0)*c.m];
}
function igDir(c, ref, def){
  var o = igEnt(c, ref);
  if(!o) return def;
  if(o.type === "IFCVECTOR") return igDir(c, o.a[0], def);
  if(!o.a[0] || !o.a[0].length) return def;
  var a = o.a[0];
  return igNorm([igNum(a[0]), igNum(a[1]), a.length > 2 ? igNum(a[2]) : 0]) || def;
}
/* IfcAxis2Placement3D (Location, Axis, RefDirection) / 2D (Location, RefDirection) / IfcAxis1Placement */
function igAxe(c, ref){
  var o = igEnt(c, ref);
  if(!o) return IG_ID;
  if(c.ax[o.id]) return c.ax[o.id];
  var O = igPoint(c, o.a[0]), Z = [0, 0, 1], X = [1, 0, 0];
  if(o.type === "IFCAXIS2PLACEMENT3D"){
    Z = igDir(c, o.a[1], [0, 0, 1]);
    X = igDir(c, o.a[2], null);
  } else if(o.type === "IFCAXIS2PLACEMENT2D"){
    X = igDir(c, o.a[1], null);
    if(X) X = [X[0], X[1], 0];
  } else if(o.type === "IFCAXIS1PLACEMENT"){
    Z = igDir(c, o.a[1], [0, 0, 1]); X = null;
  }
  if(!X || Math.abs(igDot(X, Z)) > 0.999999)
    X = Math.abs(Z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  var d = igDot(X, Z);
  X = igNorm([X[0] - d*Z[0], X[1] - d*Z[1], X[2] - d*Z[2]]) || [1, 0, 0];
  var Y = igCroix(Z, X);
  var M = [X[0], X[1], X[2], Y[0], Y[1], Y[2], Z[0], Z[1], Z[2], O[0], O[1], O[2]];
  c.ax[o.id] = M;
  return M;
}
/* IfcLocalPlacement : la chaîne jusqu'au projet, entière cette fois */
function igPlacement(c, ref){
  var o = igEnt(c, ref);
  if(!o) return IG_ID;
  if(c.pl[o.id]) return c.pl[o.id];
  c.pl[o.id] = IG_ID;                                   /* garde-fou anti-boucle */
  var M = IG_ID;
  if(o.type === "IFCLOCALPLACEMENT"){
    var pere = o.a[0] ? igPlacement(c, o.a[0]) : IG_ID;
    M = igMul(pere, igAxe(c, o.a[1]));
  } else if(o.type === "IFCAXIS2PLACEMENT3D" || o.type === "IFCAXIS2PLACEMENT2D"){
    M = igAxe(c, {ref:o.id});
  }
  c.pl[o.id] = M;
  return M;
}
/* IfcCartesianTransformationOperator3D(Axis1, Axis2, LocalOrigin, Scale, Axis3[, Scale2, Scale3]) et 2D */
function igOperateur(c, ref){
  var o = igEnt(c, ref);
  if(!o) return IG_ID;
  var O = igPoint(c, o.a[2]), s = (typeof o.a[3] === "number") ? o.a[3] : 1;
  var deux = /2D/.test(o.type);
  var Z = deux ? [0, 0, 1] : igDir(c, o.a[4], [0, 0, 1]);
  var X = igDir(c, o.a[0], null);
  if(!X || Math.abs(igDot(X, Z)) > 0.999999) X = Math.abs(Z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  var d = igDot(X, Z);
  X = igNorm([X[0] - d*Z[0], X[1] - d*Z[1], X[2] - d*Z[2]]);
  var Y = igCroix(Z, X);
  var Yd = igDir(c, o.a[1], null);
  if(Yd && igDot(Yd, Y) < 0) Y = [-Y[0], -Y[1], -Y[2]];        /* repère indirect : un miroir */
  var s2 = (!deux && typeof o.a[5] === "number") ? o.a[5] : s;
  var s3 = (!deux && typeof o.a[6] === "number") ? o.a[6] : s;
  if(deux && typeof o.a[4] === "number") s2 = o.a[4];
  return [X[0]*s, X[1]*s, X[2]*s, Y[0]*s2, Y[1]*s2, Y[2]*s2, Z[0]*s3, Z[1]*s3, Z[2]*s3, O[0], O[1], O[2]];
}

/* ---------------------------------------------------------------------
   107.3 · LES COURBES ET LES PROFILS
   Une courbe devient une suite de points ; un arc est découpé tous les
   10° — assez pour qu'un mur courbe se lise rond, pas assez pour peser.
   --------------------------------------------------------------------- */
var IG_PAS_ARC = Math.PI/18;
function igArc(Mc, a, b, t0, t1, sens){
  /* de t0 à t1, dans le sens trigonométrique si `sens`, sinon l'inverse */
  var d = t1 - t0;
  if(sens){ while(d <= 1e-9) d += 2*Math.PI; while(d > 2*Math.PI + 1e-9) d -= 2*Math.PI; }
  else { while(d >= -1e-9) d -= 2*Math.PI; while(d < -2*Math.PI - 1e-9) d += 2*Math.PI; }
  var n = Math.max(2, Math.ceil(Math.abs(d)/IG_PAS_ARC)), out = [];
  for(var k = 0; k <= n; k++){
    var t = t0 + d*k/n;
    out.push(igApp(Mc, a*Math.cos(t), b*Math.sin(t), 0));
  }
  return out;
}
function igAngleSur(Mc, a, b, p){
  var L = igApp(igInv(Mc), p[0], p[1], p[2]);
  return Math.atan2(L[1]/(b || 1), L[0]/(a || 1));
}
function igCourbe(c, ref){
  var o = igEnt(c, ref);
  if(!o) return null;
  var E = c.E, k, out;
  switch(o.type){
    case "IFCPOLYLINE":
      return (o.a[0] || []).map(function(r){ return igPoint(c, r); });
    case "IFCCOMPOSITECURVE":
      out = [];
      (o.a[0] || []).forEach(function(r){
        var sg = igEnt(c, r);
        if(!sg) return;
        var pts = igCourbe(c, sg.type === "IFCCOMPOSITECURVESEGMENT" || sg.type === "IFCREPARAMETRISEDCOMPOSITECURVESEGMENT" ? sg.a[2] : r);
        if(!pts || !pts.length) return;
        if(sg.a[1] === ".F.") pts = pts.slice().reverse();
        if(out.length && igProche(out[out.length - 1], pts[0])) pts = pts.slice(1);
        out = out.concat(pts);
      });
      return out;
    case "IFCTRIMMEDCURVE":
      return igCourbeCoupee(c, o);
    case "IFCCIRCLE":
      return igArc(igAxe(c, o.a[0]), igNum(o.a[1])*c.m, igNum(o.a[1])*c.m, 0, 2*Math.PI, true);
    case "IFCELLIPSE":
      return igArc(igAxe(c, o.a[0]), igNum(o.a[1])*c.m, igNum(o.a[2])*c.m, 0, 2*Math.PI, true);
    case "IFCINDEXEDPOLYCURVE":
      return igCourbeIndexee(c, o);
    case "IFCBSPLINECURVEWITHKNOTS": case "IFCRATIONALBSPLINECURVEWITHKNOTS": case "IFCBSPLINECURVE":
      /* approchée par son polygone de contrôle : mieux qu'un trou */
      c.stats.nonLus.BSPLINE_APPROCHEE = (c.stats.nonLus.BSPLINE_APPROCHEE || 0) + 1;
      return (o.a[1] || []).map(function(r){ return igPoint(c, r); });
    case "IFCLINE":
      return null;
  }
  c.stats.nonLus[o.type] = (c.stats.nonLus[o.type] || 0) + 1;
  return null;
}
function igProche(a, b){ return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7 && Math.abs(a[2] - b[2]) < 1e-7; }
function igCourbeCoupee(c, o){
  var base = igEnt(c, o.a[0]);
  if(!base) return null;
  var sens = o.a[3] !== ".F.";
  var trim = function(liste){
    var pt = null, par = null;
    (liste || []).forEach(function(x){
      if(x && x.ref && c.E[x.ref] && c.E[x.ref].type === "IFCCARTESIANPOINT") pt = igPoint(c, x);
      else if(x && typeof x === "object" && x.t === "IFCPARAMETERVALUE") par = igNum(x);
      else if(typeof x === "number") par = x;
    });
    return {pt:pt, par:par};
  };
  var T1 = trim(o.a[1]), T2 = trim(o.a[2]);
  var prefereParam = o.a[4] === ".PARAMETER.";
  if(base.type === "IFCLINE"){
    var P0 = igPoint(c, base.a[0]), V = igEnt(c, base.a[1]);
    var dir = V ? igDir(c, V.a[0], [1, 0, 0]) : [1, 0, 0], mag = V ? igNum(V.a[1])*c.m : 1;
    var at = function(T){
      if(T.pt && !(prefereParam && T.par !== null)) return T.pt;
      var t = (T.par || 0)*mag;
      return [P0[0] + dir[0]*t, P0[1] + dir[1]*t, P0[2] + dir[2]*t];
    };
    return [at(T1), at(T2)];
  }
  if(base.type === "IFCCIRCLE" || base.type === "IFCELLIPSE"){
    var Mc = igAxe(c, base.a[0]);
    var a = igNum(base.a[1])*c.m, b = base.type === "IFCELLIPSE" ? igNum(base.a[2])*c.m : a;
    var ang = function(T){
      if(T.pt && !(prefereParam && T.par !== null)) return igAngleSur(Mc, a, b, T.pt);
      return (T.par || 0)*c.ang;
    };
    return igArc(Mc, a, b, ang(T1), ang(T2), sens);
  }
  var pts = igCourbe(c, o.a[0]);
  return pts;
}
function igCourbeIndexee(c, o){
  var L = igEnt(c, o.a[0]);
  if(!L || !L.a[0]) return null;
  var P = L.a[0].map(function(q){ return [igNum(q[0])*c.m, igNum(q[1])*c.m, q.length > 2 ? igNum(q[2])*c.m : 0]; });
  var segs = o.a[1];
  if(!segs || !segs.length) return P;
  var out = [];
  var ajoute = function(pts){
    if(out.length && pts.length && igProche(out[out.length - 1], pts[0])) pts = pts.slice(1);
    out = out.concat(pts);
  };
  segs.forEach(function(s){
    if(!s || typeof s !== "object") return;
    var idx = (s.v && s.v.length ? s.v : []).map(function(i){ return P[(igNum(i) | 0) - 1]; }).filter(Boolean);
    if(s.t === "IFCARCINDEX" && idx.length === 3) ajoute(igArc3(idx[0], idx[1], idx[2]));
    else ajoute(idx);
  });
  return out;
}
/* l'arc qui passe par trois points (dans leur plan) */
function igArc3(A, B, C){
  var u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  var n = igCroix(u, v), nn = igDot(n, n);
  if(nn < 1e-14) return [A, C];
  var uu = igDot(u, u), vv = igDot(v, v);
  var t1 = igCroix(n, u), t2 = igCroix(v, n);
  var O = [A[0] + (vv*t1[0] + uu*t2[0])/(2*nn), A[1] + (vv*t1[1] + uu*t2[1])/(2*nn), A[2] + (vv*t1[2] + uu*t2[2])/(2*nn)];
  var X = igNorm([A[0] - O[0], A[1] - O[1], A[2] - O[2]]), Z = igNorm(n), Y = igCroix(Z, X);
  var r = Math.sqrt((A[0]-O[0])*(A[0]-O[0]) + (A[1]-O[1])*(A[1]-O[1]) + (A[2]-O[2])*(A[2]-O[2]));
  var Mc = [X[0], X[1], X[2], Y[0], Y[1], Y[2], Z[0], Z[1], Z[2], O[0], O[1], O[2]];
  var tc = igAngleSur(Mc, r, r, C);
  return igArc(Mc, r, r, 0, tc < 0 ? tc + 2*Math.PI : tc, true);
}

/* un contour plan, sans le point de fermeture répété */
function igContour2(pts){
  if(!pts) return null;
  var out = pts.map(function(p){ return [p[0], p[1]]; });
  if(out.length > 1){
    var a = out[0], b = out[out.length - 1];
    if(Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7) out.pop();
  }
  var net = [];
  out.forEach(function(p){
    var q = net[net.length - 1];
    if(!q || Math.abs(q[0] - p[0]) > 1e-9 || Math.abs(q[1] - p[1]) > 1e-9) net.push(p);
  });
  return net.length >= 3 ? net : null;
}
function igAire2(p){
  var s = 0;
  for(var i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] - p[i][0])*(p[j][1] + p[i][1]);
  return s/2;
}
function igRect(x0, y0, x1, y1){ return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
function igCercle2(r, n){
  var out = [];
  n = n || 24;
  for(var k = 0; k < n; k++){ var t = 2*Math.PI*k/n; out.push([r*Math.cos(t), r*Math.sin(t)]); }
  return out;
}
/* un profil → [{ext:[[x,y]…], trous:[[…]…]}] dans le repère du profil, position comprise */
function igProfil(c, ref){
  var o = igEnt(c, ref);
  if(!o) return [];
  if(c.pf[o.id]) return c.pf[o.id];
  var res = igProfilBrut(c, o) || [];
  c.pf[o.id] = res;
  return res;
}
function igProfilBrut(c, o){
  var m = c.m, ext = null, trous = [], pos = null;
  var N = function(i){ return igNum(o.a[i])*m; };
  switch(o.type){
    case "IFCARBITRARYCLOSEDPROFILEDEF":
      ext = igContour2(igCourbe(c, o.a[2]));
      break;
    case "IFCARBITRARYPROFILEDEFWITHVOIDS":
      ext = igContour2(igCourbe(c, o.a[2]));
      (o.a[3] || []).forEach(function(r){ var t = igContour2(igCourbe(c, r)); if(t) trous.push(t); });
      break;
    case "IFCRECTANGLEPROFILEDEF": case "IFCROUNDEDRECTANGLEPROFILEDEF":
      pos = o.a[2]; ext = igRect(-N(3)/2, -N(4)/2, N(3)/2, N(4)/2);
      break;
    case "IFCRECTANGLEHOLLOWPROFILEDEF":
      pos = o.a[2]; ext = igRect(-N(3)/2, -N(4)/2, N(3)/2, N(4)/2);
      var e = N(5);
      if(e > 0 && e*2 < Math.min(N(3), N(4))) trous.push(igRect(-N(3)/2 + e, -N(4)/2 + e, N(3)/2 - e, N(4)/2 - e));
      break;
    case "IFCCIRCLEPROFILEDEF":
      pos = o.a[2]; ext = igCercle2(N(3), 24);
      break;
    case "IFCCIRCLEHOLLOWPROFILEDEF":
      pos = o.a[2]; ext = igCercle2(N(3), 24);
      if(N(4) > 0 && N(4) < N(3)) trous.push(igCercle2(N(3) - N(4), 24));
      break;
    case "IFCELLIPSEPROFILEDEF":
      pos = o.a[2]; ext = igCercle2(1, 24).map(function(p){ return [p[0]*N(3), p[1]*N(4)]; });
      break;
    case "IFCISHAPEPROFILEDEF": case "IFCASYMMETRICISHAPEPROFILEDEF":
      pos = o.a[2];
      var b = N(3), h = N(4), tw = N(5), tf = N(6);
      ext = [[-b/2, -h/2], [b/2, -h/2], [b/2, -h/2 + tf], [tw/2, -h/2 + tf], [tw/2, h/2 - tf], [b/2, h/2 - tf], [b/2, h/2],
             [-b/2, h/2], [-b/2, h/2 - tf], [-tw/2, h/2 - tf], [-tw/2, -h/2 + tf], [-b/2, -h/2 + tf]];
      break;
    case "IFCLSHAPEPROFILEDEF":
      pos = o.a[2];
      var d = N(3), w = N(4) || N(3), t = N(5);
      ext = [[-w/2, -d/2], [w/2, -d/2], [w/2, -d/2 + t], [-w/2 + t, -d/2 + t], [-w/2 + t, d/2], [-w/2, d/2]];
      break;
    case "IFCTSHAPEPROFILEDEF":
      pos = o.a[2];
      var dT = N(3), bT = N(4), twT = N(5), tfT = N(6);
      ext = [[-twT/2, -dT/2], [twT/2, -dT/2], [twT/2, dT/2 - tfT], [bT/2, dT/2 - tfT], [bT/2, dT/2], [-bT/2, dT/2], [-bT/2, dT/2 - tfT], [-twT/2, dT/2 - tfT]];
      break;
    case "IFCUSHAPEPROFILEDEF":
      pos = o.a[2];
      var dU = N(3), bU = N(4), twU = N(5), tfU = N(6);
      ext = [[-bU/2, -dU/2], [bU/2, -dU/2], [bU/2, -dU/2 + tfU], [-bU/2 + twU, -dU/2 + tfU], [-bU/2 + twU, dU/2 - tfU], [bU/2, dU/2 - tfU], [bU/2, dU/2], [-bU/2, dU/2]];
      break;
    case "IFCCSHAPEPROFILEDEF":
      pos = o.a[2];
      var dC = N(3), bC = N(4), tC = N(5), gC = N(6);
      ext = [[-bC/2, -dC/2], [bC/2, -dC/2], [bC/2, -dC/2 + gC], [bC/2 - tC, -dC/2 + gC], [bC/2 - tC, -dC/2 + tC], [-bC/2 + tC, -dC/2 + tC],
             [-bC/2 + tC, dC/2 - tC], [bC/2 - tC, dC/2 - tC], [bC/2 - tC, dC/2 - gC], [bC/2, dC/2 - gC], [bC/2, dC/2], [-bC/2, dC/2]];
      break;
    case "IFCZSHAPEPROFILEDEF":
      pos = o.a[2];
      var dZ = N(3), bZ = N(4), twZ = N(5), tfZ = N(6);
      ext = [[-twZ/2 - bZ + twZ, -dZ/2], [twZ/2, -dZ/2], [twZ/2, dZ/2 - tfZ], [twZ/2 + bZ - twZ, dZ/2 - tfZ], [twZ/2 + bZ - twZ, dZ/2],
             [-twZ/2, dZ/2], [-twZ/2, -dZ/2 + tfZ], [-twZ/2 - bZ + twZ, -dZ/2 + tfZ]];
      break;
    case "IFCDERIVEDPROFILEDEF":
      var Mo = igOperateur(c, o.a[3]);
      return igProfil(c, o.a[2]).map(function(pr){
        var f = function(L){ return L.map(function(p){ var q = igApp(Mo, p[0], p[1], 0); return [q[0], q[1]]; }); };
        return {ext:f(pr.ext), trous:pr.trous.map(f)};
      });
    case "IFCCOMPOSITEPROFILEDEF":
      var tous = [];
      (o.a[2] || []).forEach(function(r){ tous = tous.concat(igProfil(c, r)); });
      return tous;
    default:
      c.stats.nonLus[o.type] = (c.stats.nonLus[o.type] || 0) + 1;
      return null;
  }
  if(!ext || ext.length < 3) return null;
  if(pos){
    var Mp = igAxe(c, pos);
    var f2 = function(L){ return L.map(function(p){ var q = igApp(Mp, p[0], p[1], 0); return [q[0], q[1]]; }); };
    ext = f2(ext); trous = trous.map(f2);
  }
  /* sens trigonométrique pour le contour, horaire pour les trous */
  if(igAire2(ext) < 0) ext = ext.slice().reverse();
  trous = trous.map(function(t){ return igAire2(t) > 0 ? t.slice().reverse() : t; });
  return [{ext:ext, trous:trous}];
}

/* ---------------------------------------------------------------------
   107.4 · LA TRIANGULATION D'UN POLYGONE À TROUS
   Les trous sont raccordés au contour par un pont (le sommet visible le
   plus proche), puis on coupe les « oreilles » une à une. Lent sur un
   polygone de dix mille côtés, instantané sur ceux d'un bâtiment.
   --------------------------------------------------------------------- */
function igSegCoupe(a, b, c, d){
  var o = function(p, q, r){ var v = (q[0] - p[0])*(r[1] - p[1]) - (q[1] - p[1])*(r[0] - p[0]); return v > 1e-12 ? 1 : v < -1e-12 ? -1 : 0; };
  var o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1*o2 < 0 && o3*o4 < 0;
}
function igTrianguler(ext, trous){
  var V = ext.slice(), anneau = ext.map(function(_p, i){ return i; });
  if(igAire2(ext) < 0){ anneau.reverse(); }
  var listeT = (trous || []).filter(function(t){ return t && t.length >= 3; }).map(function(t){
    var b = V.length;
    t.forEach(function(p){ V.push(p); });
    var idx = t.map(function(_p, i){ return b + i; });
    if(igAire2(t) > 0) idx.reverse();
    var mx = -Infinity, im = 0;
    idx.forEach(function(k, j){ if(V[k][0] > mx){ mx = V[k][0]; im = j; } });
    return {idx:idx, im:im, mx:mx};
  });
  listeT.sort(function(a, b){ return b.mx - a.mx; });
  listeT.forEach(function(T, n){
    var M = V[T.idx[T.im]];
    var cand = anneau.map(function(k, j){ return {k:k, j:j, d:(V[k][0] - M[0])*(V[k][0] - M[0]) + (V[k][1] - M[1])*(V[k][1] - M[1])}; });
    cand.sort(function(a, b){ return a.d - b.d; });
    var choisi = cand[0];
    for(var q = 0; q < cand.length; q++){
      var P = V[cand[q].k], ok = true;
      for(var i = 0; i < anneau.length && ok; i++){
        var A = V[anneau[i]], B = V[anneau[(i + 1) % anneau.length]];
        if(igSegCoupe(M, P, A, B)) ok = false;
      }
      for(var h = n; h < listeT.length && ok; h++){
        var I = listeT[h].idx;
        for(var r = 0; r < I.length && ok; r++) if(igSegCoupe(M, P, V[I[r]], V[I[(r + 1) % I.length]])) ok = false;
      }
      if(ok){ choisi = cand[q]; break; }
    }
    var rot = T.idx.slice(T.im).concat(T.idx.slice(0, T.im));
    var ins = [choisi.k].concat(rot, [rot[0], choisi.k]);
    anneau = anneau.slice(0, choisi.j).concat(ins, anneau.slice(choisi.j + 1));
  });
  return {pts:V, tri:igOreilles(V, anneau)};
}
function igOreilles(V, anneau){
  var tri = [], R = anneau.slice(), garde = 0;
  var cr = function(a, b, c){ return (V[b][0] - V[a][0])*(V[c][1] - V[a][1]) - (V[b][1] - V[a][1])*(V[c][0] - V[a][0]); };
  var dedans = function(p, a, b, c){
    var P = V[p], A = V[a], B = V[b], C = V[c];
    if((P[0] === A[0] && P[1] === A[1]) || (P[0] === B[0] && P[1] === B[1]) || (P[0] === C[0] && P[1] === C[1])) return false;
    var d1 = (B[0] - A[0])*(P[1] - A[1]) - (B[1] - A[1])*(P[0] - A[0]);
    var d2 = (C[0] - B[0])*(P[1] - B[1]) - (C[1] - B[1])*(P[0] - B[0]);
    var d3 = (A[0] - C[0])*(P[1] - C[1]) - (A[1] - C[1])*(P[0] - C[0]);
    return d1 >= -1e-14 && d2 >= -1e-14 && d3 >= -1e-14;
  };
  var i = 0;
  while(R.length > 3 && garde < 100000){
    garde++;
    var n = R.length, a = R[(i + n - 1) % n], b = R[i % n], c = R[(i + 1) % n];
    var oreille = cr(a, b, c) > 1e-14;
    if(oreille){
      for(var k = 0; k < n; k++){
        var p = R[k];
        if(p === a || p === b || p === c) continue;
        if(dedans(p, a, b, c)){ oreille = false; break; }
      }
    }
    if(oreille){ tri.push([a, b, c]); R.splice(i % n, 1); i = Math.max(0, (i % n) - 1); garde = 0; continue; }
    i = (i + 1) % n;
    if(garde > n*2){
      /* plus aucune oreille propre (contour dégénéré) : on retire le sommet le moins mauvais */
      var bi = 0, bv = -Infinity;
      for(var t = 0; t < n; t++){ var v = cr(R[(t + n - 1) % n], R[t], R[(t + 1) % n]); if(v > bv){ bv = v; bi = t; } }
      if(bv > 1e-14) tri.push([R[(bi + n - 1) % n], R[bi], R[(bi + 1) % n]]);
      R.splice(bi, 1); garde = 0; i = 0;
    }
  }
  if(R.length === 3 && cr(R[0], R[1], R[2]) > 1e-14) tri.push([R[0], R[1], R[2]]);
  return tri;
}
/* une face plane dans l'espace (contour + trous) → triangles, dans le sens du contour */
function igFace3(sortie, ext, trous){
  if(!ext || ext.length < 3) return;
  var n = [0, 0, 0];
  for(var i = 0, j = ext.length - 1; i < ext.length; j = i++){
    n[0] += (ext[j][1] - ext[i][1])*(ext[j][2] + ext[i][2]);
    n[1] += (ext[j][2] - ext[i][2])*(ext[j][0] + ext[i][0]);
    n[2] += (ext[j][0] - ext[i][0])*(ext[j][1] + ext[i][1]);
  }
  var N = igNorm(n);
  if(!N) return;
  if(ext.length === 3 && !(trous && trous.length)){
    sortie.push(ext[0][0], ext[0][1], ext[0][2], ext[1][0], ext[1][1], ext[1][2], ext[2][0], ext[2][1], ext[2][2]);
    return;
  }
  var U = Math.abs(N[0]) < 0.9 ? igNorm(igCroix([1, 0, 0], N)) : igNorm(igCroix([0, 1, 0], N));
  var W = igCroix(N, U);
  var p2 = function(p){ return [igDot(p, U), igDot(p, W)]; };
  var tous = ext.slice();
  var T = (trous || []).filter(function(t){ return t && t.length >= 3; });
  T.forEach(function(t){ tous = tous.concat(t); });
  var R = igTrianguler(ext.map(p2), T.map(function(t){ return t.map(p2); }));
  R.tri.forEach(function(t){
    var A = tous[t[0]], B = tous[t[1]], C = tous[t[2]];
    if(!A || !B || !C) return;
    sortie.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
  });
}

/* ---------------------------------------------------------------------
   107.5 · LES SOLIDES
   Tout se ramène à une liste de triangles (9 nombres chacun) dans le
   repère de l'objet. Un solide fermé est remis à l'endroit par le signe
   de son volume : c'est plus sûr que de suivre les sens de parcours de
   chaque exportateur.
   --------------------------------------------------------------------- */
function igVolume(t){
  var v = 0;
  for(var i = 0; i < t.length; i += 9)
    v += t[i]*(t[i+4]*t[i+8] - t[i+5]*t[i+7]) - t[i+1]*(t[i+3]*t[i+8] - t[i+5]*t[i+6]) + t[i+2]*(t[i+3]*t[i+7] - t[i+4]*t[i+6]);
  return v/6;
}
function igRetourner(t){
  for(var i = 0; i < t.length; i += 9){
    var x = t[i+3], y = t[i+4], z = t[i+5];
    t[i+3] = t[i+6]; t[i+4] = t[i+7]; t[i+5] = t[i+8];
    t[i+6] = x; t[i+7] = y; t[i+8] = z;
  }
  return t;
}
function igRedresser(t){ if(igVolume(t) < 0) igRetourner(t); return t; }
function igTransformer(t, M){
  var out = new Array(t.length);
  for(var i = 0; i < t.length; i += 3){
    var x = t[i], y = t[i+1], z = t[i+2];
    out[i] = M[0]*x + M[3]*y + M[6]*z + M[9];
    out[i+1] = M[1]*x + M[4]*y + M[7]*z + M[10];
    out[i+2] = M[2]*x + M[5]*y + M[8]*z + M[11];
  }
  if(igDet(M) < 0) igRetourner(out);                       /* un miroir retourne les faces */
  return out;
}
function igBoite(t){
  var b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for(var i = 0; i < t.length; i += 3){
    if(t[i] < b[0]) b[0] = t[i]; if(t[i] > b[3]) b[3] = t[i];
    if(t[i+1] < b[1]) b[1] = t[i+1]; if(t[i+1] > b[4]) b[4] = t[i+1];
    if(t[i+2] < b[2]) b[2] = t[i+2]; if(t[i+2] > b[5]) b[5] = t[i+2];
  }
  return b;
}

/* IfcExtrudedAreaSolid(SweptArea, Position, ExtrudedDirection, Depth) */
function igExtrusion(c, o){
  var profs = igProfil(c, o.a[0]);
  if(!profs.length) return null;
  var M = igAxe(c, o.a[1]);
  var d = igDir(c, o.a[2], [0, 0, 1]), L = igNum(o.a[3])*c.m;
  if(!(Math.abs(L) > 1e-9)) return null;
  var v = [d[0]*L, d[1]*L, d[2]*L], t = [];
  profs.forEach(function(pr){
    var R = igTrianguler(pr.ext, pr.trous);
    var V = R.pts;
    R.tri.forEach(function(q){
      var A = V[q[0]], B = V[q[1]], C = V[q[2]];
      t.push(A[0], A[1], 0, C[0], C[1], 0, B[0], B[1], 0);                       /* dessous */
      t.push(A[0] + v[0], A[1] + v[1], v[2], B[0] + v[0], B[1] + v[1], v[2], C[0] + v[0], C[1] + v[1], v[2]);
    });
    [pr.ext].concat(pr.trous).forEach(function(L2){
      for(var i = 0; i < L2.length; i++){
        var a = L2[i], b = L2[(i + 1) % L2.length];
        t.push(a[0], a[1], 0, b[0], b[1], 0, b[0] + v[0], b[1] + v[1], v[2]);
        t.push(a[0], a[1], 0, b[0] + v[0], b[1] + v[1], v[2], a[0] + v[0], a[1] + v[1], v[2]);
      }
    });
  });
  return {t:igRedresser(igTransformer(t, M)), ferme:true};
}
/* IfcRevolvedAreaSolid(SweptArea, Position, Axis, Angle) */
function igRevolution(c, o){
  var profs = igProfil(c, o.a[0]);
  if(!profs.length) return null;
  var M = igAxe(c, o.a[1]), ax = igEnt(c, o.a[2]);
  var A0 = ax ? igPoint(c, ax.a[0]) : [0, 0, 0], Ad = ax ? igDir(c, ax.a[1], [0, 1, 0]) : [0, 1, 0];
  var ang = igNum(o.a[3])*c.ang;
  if(!(Math.abs(ang) > 1e-6)) return null;
  var n = Math.max(3, Math.ceil(Math.abs(ang)/IG_PAS_ARC)), plein = Math.abs(Math.abs(ang) - 2*Math.PI) < 1e-3;
  var rot = function(p, th){
    var x = p[0] - A0[0], y = p[1] - A0[1], z = p[2] - A0[2];
    var cs = Math.cos(th), sn = Math.sin(th), k = Ad, d = k[0]*x + k[1]*y + k[2]*z;
    var cx = k[1]*z - k[2]*y, cy = k[2]*x - k[0]*z, cz = k[0]*y - k[1]*x;
    return [A0[0] + x*cs + cx*sn + k[0]*d*(1 - cs), A0[1] + y*cs + cy*sn + k[1]*d*(1 - cs), A0[2] + z*cs + cz*sn + k[2]*d*(1 - cs)];
  };
  var t = [];
  profs.forEach(function(pr){
    [pr.ext].concat(pr.trous).forEach(function(L2){
      var P3 = L2.map(function(p){ return [p[0], p[1], 0]; });
      for(var s = 0; s < n; s++){
        var a0 = ang*s/n, a1 = ang*(s + 1)/n;
        for(var i = 0; i < P3.length; i++){
          var p = P3[i], q = P3[(i + 1) % P3.length];
          var A = rot(p, a0), B = rot(q, a0), C = rot(q, a1), D = rot(p, a1);
          t.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
        }
      }
    });
    if(!plein){
      var R = igTrianguler(pr.ext, pr.trous), V = R.pts;
      R.tri.forEach(function(q){
        var A = [V[q[0]][0], V[q[0]][1], 0], B = [V[q[1]][0], V[q[1]][1], 0], C = [V[q[2]][0], V[q[2]][1], 0];
        t.push(A[0], A[1], A[2], C[0], C[1], C[2], B[0], B[1], B[2]);
        var A2 = rot(A, ang), B2 = rot(B, ang), C2 = rot(C, ang);
        t.push(A2[0], A2[1], A2[2], B2[0], B2[1], B2[2], C2[0], C2[1], C2[2]);
      });
    }
  });
  return {t:igRedresser(igTransformer(t, M)), ferme:true};
}
/* IfcSweptDiskSolid(Directrix, Radius, InnerRadius, StartParam, EndParam) — une main courante */
function igTube(c, o){
  var pts = igCourbe(c, o.a[0]), r = igNum(o.a[1])*c.m;
  if(!pts || pts.length < 2 || !(r > 0)) return null;
  var nC = 8, t = [], anneaux = [];
  for(var i = 0; i < pts.length; i++){
    var p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    var T = igNorm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) || [0, 0, 1];
    var U = igNorm(igCroix(T, Math.abs(T[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), W = igCroix(T, U);
    var ann = [];
    for(var k = 0; k < nC; k++){
      var th = 2*Math.PI*k/nC, cs = Math.cos(th)*r, sn = Math.sin(th)*r;
      ann.push([p[0] + U[0]*cs + W[0]*sn, p[1] + U[1]*cs + W[1]*sn, p[2] + U[2]*cs + W[2]*sn]);
    }
    anneaux.push(ann);
  }
  for(var s = 0; s + 1 < anneaux.length; s++){
    var R0 = anneaux[s], R1 = anneaux[s + 1];
    for(var k2 = 0; k2 < nC; k2++){
      var A = R0[k2], B = R0[(k2 + 1) % nC], C = R1[(k2 + 1) % nC], D = R1[k2];
      t.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
    }
  }
  [anneaux[0], anneaux[anneaux.length - 1].slice().reverse()].forEach(function(ann){
    for(var k3 = 1; k3 + 1 < nC; k3++)
      t.push(ann[0][0], ann[0][1], ann[0][2], ann[k3 + 1][0], ann[k3 + 1][1], ann[k3 + 1][2], ann[k3][0], ann[k3][1], ann[k3][2]);
  });
  return {t:igRedresser(t), ferme:true};
}
/* les facettes : B-Rep, coques, surfaces faite de faces */
function igFaces(c, listeFaces, t){
  var E = c.E;
  (listeFaces || []).forEach(function(r){
    var f = igEnt(c, r);
    if(!f || (f.type !== "IFCFACE" && f.type !== "IFCFACESURFACE" && f.type !== "IFCADVANCEDFACE")) return;
    var ext = null, trous = [];
    (f.a[0] || []).forEach(function(rb){
      var b = igEnt(c, rb);
      if(!b) return;
      var lp = igEnt(c, b.a[0]);
      if(!lp || lp.type !== "IFCPOLYLOOP") return;
      var pts = (lp.a[0] || []).map(function(q){ return igPoint(c, q); });
      if(pts.length < 3) return;
      if(b.a[1] === ".F.") pts.reverse();
      if(b.type === "IFCFACEOUTERBOUND" && !ext) ext = pts; else trous.push(pts);
    });
    if(!ext && trous.length){
      /* pas de contour désigné : le plus grand */
      var meilleur = 0, aire = -1;
      trous.forEach(function(p, k){ var bb = igBoite([].concat.apply([], p)); var a2 = (bb[3] - bb[0]) + (bb[4] - bb[1]) + (bb[5] - bb[2]); if(a2 > aire){ aire = a2; meilleur = k; } });
      ext = trous.splice(meilleur, 1)[0];
    }
    if(ext) igFace3(t, ext, trous);
  });
  void E;
}
function igCoque(c, ref, t){
  var s = igEnt(c, ref);
  if(!s) return;
  if(s.type === "IFCCLOSEDSHELL" || s.type === "IFCOPENSHELL" || s.type === "IFCCONNECTEDFACESET") igFaces(c, s.a[0], t);
}
/* IFC4 : les maillages indexés */
function igFaceSet(c, o){
  var L = igEnt(c, o.a[0]);
  if(!L || !L.a[0]) return null;
  var P = L.a[0].map(function(q){ return [igNum(q[0])*c.m, igNum(q[1])*c.m, igNum(q[2])*c.m]; });
  var t = [], ferme = o.a[1] === ".T.";
  if(o.type === "IFCTRIANGULATEDFACESET" || o.type === "IFCTRIANGULATEDIRREGULARNETWORK"){
    var pn = o.a[4];
    (o.a[3] || []).forEach(function(tr){
      var ix = tr.map(function(k){ k = igNum(k) | 0; return pn && pn.length ? (igNum(pn[k - 1]) | 0) : k; });
      var A = P[ix[0] - 1], B = P[ix[1] - 1], C = P[ix[2] - 1];
      if(A && B && C) t.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
    });
  } else {
    var pn2 = o.a[3];
    var pris = function(k){ k = igNum(k) | 0; return P[(pn2 && pn2.length ? (igNum(pn2[k - 1]) | 0) : k) - 1]; };
    (o.a[2] || []).forEach(function(r){
      var f = igEnt(c, r);
      if(!f) return;
      var ext = (f.a[0] || []).map(pris).filter(Boolean);
      var trous = f.type === "IFCINDEXEDPOLYGONALFACEWITHVOIDS" ? (f.a[1] || []).map(function(h){ return h.map(pris).filter(Boolean); }) : [];
      igFace3(t, ext, trous);
    });
  }
  if(ferme) igRedresser(t);
  return {t:t, ferme:ferme};
}
/* les primitives de géométrie constructive */
function igPrimitive(c, o){
  var M = igAxe(c, o.a[0]), t = [], m = c.m;
  if(o.type === "IFCBLOCK"){
    var X = igNum(o.a[1])*m, Y = igNum(o.a[2])*m, Z = igNum(o.a[3])*m;
    igBoiteTri(t, 0, 0, 0, X, Y, Z);
  } else if(o.type === "IFCRIGHTCIRCULARCYLINDER"){
    var H = igNum(o.a[1])*m, R = igNum(o.a[2])*m, C = igCercle2(R, 24);
    var ext = C;
    var Tr = igTrianguler(ext, []);
    Tr.tri.forEach(function(q){
      var A = ext[q[0]], B = ext[q[1]], D = ext[q[2]];
      t.push(A[0], A[1], 0, D[0], D[1], 0, B[0], B[1], 0, A[0], A[1], H, B[0], B[1], H, D[0], D[1], H);
    });
    for(var i = 0; i < C.length; i++){
      var a = C[i], b = C[(i + 1) % C.length];
      t.push(a[0], a[1], 0, b[0], b[1], 0, b[0], b[1], H, a[0], a[1], 0, b[0], b[1], H, a[0], a[1], H);
    }
  } else if(o.type === "IFCSPHERE"){
    var Rs = igNum(o.a[1])*m, nU = 16, nV = 10;
    for(var u = 0; u < nU; u++) for(var v = 0; v < nV; v++){
      var p = function(uu, vv){ var th = 2*Math.PI*uu/nU, ph = Math.PI*vv/nV - Math.PI/2; return [Rs*Math.cos(ph)*Math.cos(th), Rs*Math.cos(ph)*Math.sin(th), Rs*Math.sin(ph)]; };
      var A2 = p(u, v), B2 = p(u + 1, v), C2 = p(u + 1, v + 1), D2 = p(u, v + 1);
      t.push(A2[0], A2[1], A2[2], B2[0], B2[1], B2[2], C2[0], C2[1], C2[2], A2[0], A2[1], A2[2], C2[0], C2[1], C2[2], D2[0], D2[1], D2[2]);
    }
  } else return null;
  return {t:igRedresser(igTransformer(t, M)), ferme:true};
}
function igBoiteTri(t, x0, y0, z0, x1, y1, z1){
  var P = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]].forEach(function(f){
    var A = P[f[0]], B = P[f[1]], C = P[f[2]], D = P[f[3]];
    t.push(A[0],A[1],A[2],B[0],B[1],B[2],C[0],C[1],C[2], A[0],A[1],A[2],C[0],C[1],C[2],D[0],D[1],D[2]);
  });
}

/* ---------------------------------------------------------------------
   107.5b · LE CALCUL DES SOLIDES (arbre BSP)
   Retrancher un volume d'un autre : c'est ce que fait Revit quand il
   coupe un pignon sous la pente du toit, ou perce un mur pour une
   fenêtre. Méthode classique des arbres de partition binaire : chaque
   solide range ses faces dans un arbre de plans, on rogne l'un par
   l'autre, on garde ce qui reste. Écrit sans récursion, pour qu'un mur
   finement facetté ne fasse pas déborder la pile.
   --------------------------------------------------------------------- */
var IG_EPS = 1e-5;
function igPoly(v){
  var n = igNorm(igCroix([v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]], [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]]));
  if(!n) return null;
  return {v:v, n:n, w:igDot(n, v[0])};
}
function igPolysDe(t){
  var out = [];
  for(var i = 0; i < t.length; i += 9){
    var p = igPoly([[t[i], t[i+1], t[i+2]], [t[i+3], t[i+4], t[i+5]], [t[i+6], t[i+7], t[i+8]]]);
    if(p) out.push(p);
  }
  return out;
}
function igTrisDe(polys){
  var t = [];
  polys.forEach(function(p){
    for(var k = 1; k + 1 < p.v.length; k++){
      var A = p.v[0], B = p.v[k], C = p.v[k + 1];
      t.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
    }
  });
  return t;
}
function igRetournerPoly(p){ return {v:p.v.slice().reverse(), n:[-p.n[0], -p.n[1], -p.n[2]], w:-p.w}; }
function igDecouper(pl, p, coAv, coAr, av, ar){
  var types = [], tout = 0, nv = p.v.length;
  for(var i = 0; i < nv; i++){
    var d = igDot(pl.n, p.v[i]) - pl.w;
    var ty = d < -IG_EPS ? 2 : d > IG_EPS ? 1 : 0;
    tout |= ty; types.push(ty);
  }
  if(tout === 0){ (igDot(pl.n, p.n) > 0 ? coAv : coAr).push(p); return; }
  if(tout === 1){ av.push(p); return; }
  if(tout === 2){ ar.push(p); return; }
  var f = [], b = [];
  for(var k = 0; k < nv; k++){
    var j = (k + 1) % nv, ti = types[k], tj = types[j], vi = p.v[k], vj = p.v[j];
    if(ti !== 2) f.push(vi);
    if(ti !== 1) b.push(vi);
    if((ti | tj) === 3){
      var den = igDot(pl.n, [vj[0] - vi[0], vj[1] - vi[1], vj[2] - vi[2]]);
      var s = (pl.w - igDot(pl.n, vi))/den;
      var q = [vi[0] + (vj[0] - vi[0])*s, vi[1] + (vj[1] - vi[1])*s, vi[2] + (vj[2] - vi[2])*s];
      f.push(q); b.push(q);
    }
  }
  if(f.length >= 3) av.push({v:f, n:p.n, w:p.w});
  if(b.length >= 3) ar.push({v:b, n:p.n, w:p.w});
}
function igNoeud(){ return {pl:null, av:null, ar:null, p:[]}; }
function igConstruire(racine, polys){
  var pile = [[racine, polys]], garde = 0;
  while(pile.length){
    if(++garde > 400000) throw new Error("arbre trop profond");
    var e = pile.pop(), n = e[0], ps = e[1];
    if(!ps.length) continue;
    if(!n.pl) n.pl = {n:ps[0].n, w:ps[0].w};
    var f = [], b = [];
    for(var i = 0; i < ps.length; i++) igDecouper(n.pl, ps[i], n.p, n.p, f, b);
    if(f.length){ if(!n.av) n.av = igNoeud(); pile.push([n.av, f]); }
    if(b.length){ if(!n.ar) n.ar = igNoeud(); pile.push([n.ar, b]); }
  }
}
function igRogner(racine, polys){
  var res = [], pile = [[racine, polys]];
  while(pile.length){
    var e = pile.pop(), n = e[0], ps = e[1];
    if(!ps.length) continue;
    if(!n.pl){ for(var k = 0; k < ps.length; k++) res.push(ps[k]); continue; }
    var f = [], b = [];
    for(var i = 0; i < ps.length; i++) igDecouper(n.pl, ps[i], f, b, f, b);
    if(n.av) pile.push([n.av, f]); else for(var q = 0; q < f.length; q++) res.push(f[q]);
    if(n.ar) pile.push([n.ar, b]);
  }
  return res;
}
function igNoeuds(racine){
  var out = [], pile = [racine];
  while(pile.length){ var n = pile.pop(); out.push(n); if(n.av) pile.push(n.av); if(n.ar) pile.push(n.ar); }
  return out;
}
function igRognerPar(a, b){ igNoeuds(a).forEach(function(n){ n.p = igRogner(b, n.p); }); }
function igInverser(a){
  igNoeuds(a).forEach(function(n){
    n.p = n.p.map(igRetournerPoly);
    if(n.pl) n.pl = {n:[-n.pl.n[0], -n.pl.n[1], -n.pl.n[2]], w:-n.pl.w};
    var x = n.av; n.av = n.ar; n.ar = x;
  });
}
function igTous(a){ var out = []; igNoeuds(a).forEach(function(n){ for(var i = 0; i < n.p.length; i++) out.push(n.p[i]); }); return out; }
function igCsg(tA, tB, op){
  var a = igNoeud(), b = igNoeud();
  igConstruire(a, igPolysDe(tA));
  igConstruire(b, igPolysDe(tB));
  if(op === "moins"){
    igInverser(a); igRognerPar(a, b); igRognerPar(b, a);
    igInverser(b); igRognerPar(b, a); igInverser(b);
    igConstruire(a, igTous(b)); igInverser(a);
  } else if(op === "inter"){
    igInverser(a); igRognerPar(b, a); igInverser(b);
    igRognerPar(a, b); igRognerPar(b, a);
    igConstruire(a, igTous(b)); igInverser(a);
  } else {
    igRognerPar(a, b); igRognerPar(b, a);
    igInverser(b); igRognerPar(b, a); igInverser(b);
    igConstruire(a, igTous(b));
  }
  return igTrisDe(igTous(a));
}
/* un demi-espace devient un grand bloc, borné à ce qu'il doit couper */
function igDemiEspace(c, o, boiteCible){
  var surf = igEnt(c, o.a[0]);
  if(!surf || surf.type !== "IFCPLANE") { c.stats.nonLus[(surf && surf.type) || "DEMI-ESPACE"] = 1; return null; }
  var Mp = igAxe(c, surf.a[0]);
  var accord = o.a[1] !== ".F.";
  var diag = Math.sqrt(Math.pow(boiteCible[3] - boiteCible[0], 2) + Math.pow(boiteCible[4] - boiteCible[1], 2) + Math.pow(boiteCible[5] - boiteCible[2], 2));
  var R = diag + 1;
  var cx = (boiteCible[0] + boiteCible[3])/2, cy = (boiteCible[1] + boiteCible[4])/2, cz = (boiteCible[2] + boiteCible[5])/2;
  var Mi = igInv(Mp), cl = igApp(Mi, cx, cy, cz);
  /* le côté de la matière : sous le plan si l'accord est vrai (la normale s'en éloigne) */
  var t = [];
  if(accord) igBoiteTri(t, cl[0] - R, cl[1] - R, Math.min(0, cl[2]) - 2*R, cl[0] + R, cl[1] + R, 0);
  else igBoiteTri(t, cl[0] - R, cl[1] - R, 0, cl[0] + R, cl[1] + R, Math.max(0, cl[2]) + 2*R);
  var demi = igTransformer(t, Mp);
  if(o.type === "IFCPOLYGONALBOUNDEDHALFSPACE"){
    var Mb = igAxe(c, o.a[2]);
    var poly = igContour2(igCourbe(c, o.a[3]));
    if(!poly) return demi;
    if(igAire2(poly) < 0) poly = poly.slice().reverse();
    var cb = igApp(igInv(Mb), cx, cy, cz);
    var z0 = cb[2] - 2*R, z1 = cb[2] + 2*R, pr = [];
    var Tr = igTrianguler(poly, []);
    Tr.tri.forEach(function(q){
      var A = poly[q[0]], B = poly[q[1]], C = poly[q[2]];
      pr.push(A[0], A[1], z0, C[0], C[1], z0, B[0], B[1], z0, A[0], A[1], z1, B[0], B[1], z1, C[0], C[1], z1);
    });
    for(var i = 0; i < poly.length; i++){
      var a = poly[i], b = poly[(i + 1) % poly.length];
      pr.push(a[0], a[1], z0, b[0], b[1], z0, b[0], b[1], z1, a[0], a[1], z0, b[0], b[1], z1, a[0], a[1], z1);
    }
    var prisme = igRedresser(igTransformer(pr, Mb));
    try { return igCsg(demi, prisme, "inter"); } catch(_e){ return demi; }
  }
  return demi;
}
var IG_CSG_MAX = 6000;           /* au-delà (triangles), on n'ose pas le calcul : le volume reste entier */
function igBooleen(c, o){
  var A = igSolide(c, o.a[1]);
  if(!A || !A.t.length) return A;
  var op = String(o.a[0] || "").replace(/\./g, "");
  var bo = igEnt(c, o.a[2]);
  var B = null;
  if(bo && /HALFSPACE/.test(bo.type)){
    var t2 = igDemiEspace(c, bo, igBoite(A.t));
    B = t2 ? {t:t2, ferme:true} : null;
  } else B = igSolide(c, o.a[2]);
  if(!B || !B.t.length) return A;
  if(A.t.length/9 > IG_CSG_MAX || B.t.length/9 > IG_CSG_MAX){ c.stats.csgEchecs++; return op === "UNION" ? {t:A.t.concat(B.t), ferme:A.ferme} : A; }
  try {
    c.stats.csg++;
    var r = igCsg(A.t, B.t, op === "DIFFERENCE" ? "moins" : op === "INTERSECTION" ? "inter" : "union");
    return {t:r, ferme:A.ferme};
  } catch(e){ c.stats.csgEchecs++; return A; }
}
/* un élément géométrique → {t, ferme} dans son repère */
function igSolide(c, ref){
  var o = igEnt(c, ref);
  if(!o) return null;
  switch(o.type){
    case "IFCEXTRUDEDAREASOLID": case "IFCEXTRUDEDAREASOLIDTAPERED": return igExtrusion(c, o);
    case "IFCREVOLVEDAREASOLID": case "IFCREVOLVEDAREASOLIDTAPERED": return igRevolution(c, o);
    case "IFCSWEPTDISKSOLID": case "IFCSWEPTDISKSOLIDPOLYGONAL": return igTube(c, o);
    case "IFCFACETEDBREP": case "IFCFACETEDBREPWITHVOIDS": case "IFCADVANCEDBREP": {
      var t = [];
      igCoque(c, o.a[0], t);
      if(!t.length){ c.stats.nonLus[o.type] = (c.stats.nonLus[o.type] || 0) + 1; return null; }
      return {t:igRedresser(t), ferme:true};
    }
    case "IFCCLOSEDSHELL": case "IFCOPENSHELL": case "IFCCONNECTEDFACESET": {
      var t1 = [];
      igCoque(c, {ref:o.id}, t1);
      return {t:t1, ferme:o.type === "IFCCLOSEDSHELL"};
    }
    case "IFCFACEBASEDSURFACEMODEL": case "IFCSHELLBASEDSURFACEMODEL": {
      var t3 = [];
      (o.a[0] || []).forEach(function(r){ igCoque(c, r, t3); });
      return {t:t3, ferme:false};
    }
    case "IFCPOLYGONALFACESET": case "IFCTRIANGULATEDFACESET": case "IFCTRIANGULATEDIRREGULARNETWORK":
      return igFaceSet(c, o);
    case "IFCBOOLEANCLIPPINGRESULT": case "IFCBOOLEANRESULT":
      return igBooleen(c, o);
    case "IFCCSGSOLID": return igSolide(c, o.a[0]);
    case "IFCBLOCK": case "IFCRIGHTCIRCULARCYLINDER": case "IFCSPHERE": return igPrimitive(c, o);
  }
  c.stats.nonLus[o.type] = (c.stats.nonLus[o.type] || 0) + 1;
  return null;
}

/* ---------------------------------------------------------------------
   107.5c · LES COULEURS DU FICHIER
   Un IfcStyledItem colle une couleur à un élément géométrique ; à défaut,
   le matériau de l'ouvrage en porte une ; à défaut encore, la classe de
   l'ouvrage en suggère une (le terrain vert, la toiture tuile…).
   --------------------------------------------------------------------- */
var IG_COUL_CLASSE = {
  IFCSITE:[0.56, 0.69, 0.32, 1], IFCGEOGRAPHICELEMENT:[0.56, 0.69, 0.32, 1],
  IFCROOF:[0.66, 0.22, 0.20, 1], IFCWINDOW:[0.55, 0.72, 0.85, 0.45], IFCDOOR:[0.55, 0.37, 0.22, 1],
  IFCWALL:[0.91, 0.88, 0.80, 1], IFCWALLSTANDARDCASE:[0.91, 0.88, 0.80, 1], IFCCURTAINWALL:[0.55, 0.72, 0.85, 0.5],
  IFCSLAB:[0.74, 0.74, 0.72, 1], IFCFOOTING:[0.62, 0.62, 0.60, 1], IFCPILE:[0.62, 0.62, 0.60, 1],
  IFCCOLUMN:[0.78, 0.78, 0.76, 1], IFCBEAM:[0.78, 0.78, 0.76, 1], IFCMEMBER:[0.72, 0.60, 0.45, 1],
  IFCPLATE:[0.62, 0.75, 0.85, 0.5], IFCRAILING:[0.30, 0.30, 0.32, 1], IFCSTAIR:[0.80, 0.78, 0.72, 1],
  IFCSTAIRFLIGHT:[0.80, 0.78, 0.72, 1], IFCRAMP:[0.80, 0.78, 0.72, 1], IFCRAMPFLIGHT:[0.80, 0.78, 0.72, 1],
  IFCCOVERING:[0.88, 0.86, 0.82, 1], IFCFURNISHINGELEMENT:[0.70, 0.55, 0.40, 1], IFCFURNITURE:[0.70, 0.55, 0.40, 1],
  IFCBUILDINGELEMENTPROXY:[0.62, 0.62, 0.64, 1], IFCFLOWTERMINAL:[0.85, 0.85, 0.88, 1], IFCDISTRIBUTIONELEMENT:[0.6, 0.65, 0.7, 1]
};
function igCouleurStyle(c, ref, prof){
  var o = igEnt(c, ref);
  if(!o || (prof || 0) > 6) return null;
  switch(o.type){
    case "IFCSTYLEDITEM":
      var lst = o.a[1] || [];
      for(var i = 0; i < lst.length; i++){ var r = igCouleurStyle(c, lst[i], (prof || 0) + 1); if(r) return r; }
      return null;
    case "IFCPRESENTATIONSTYLEASSIGNMENT":
      var l2 = o.a[0] || [];
      for(var j = 0; j < l2.length; j++){ var r2 = igCouleurStyle(c, l2[j], (prof || 0) + 1); if(r2) return r2; }
      return null;
    case "IFCSURFACESTYLE":
      var l3 = o.a[2] || [], meilleur = null;
      for(var k = 0; k < l3.length; k++){
        var s = igEnt(c, l3[k]);
        if(!s || (s.type !== "IFCSURFACESTYLERENDERING" && s.type !== "IFCSURFACESTYLESHADING")) continue;
        var col = igEnt(c, s.a[0]);
        if(!col || col.type !== "IFCCOLOURRGB") continue;
        var tr = s.a[1] !== undefined && s.a[1] !== null ? igNum(s.a[1]) : 0;
        meilleur = [igNum(col.a[1]), igNum(col.a[2]), igNum(col.a[3]), Math.max(0.15, 1 - tr)];
        if(s.type === "IFCSURFACESTYLERENDERING") break;
      }
      return meilleur;
  }
  return null;
}
function igIndexCouleurs(c){
  if(c.styles) return;
  var E = c.E, st = {}, mat = {};
  (c.P.parType.IFCSTYLEDITEM || []).forEach(function(id){
    var o = E[id];
    if(!o.a[0] || !o.a[0].ref) return;
    var col = igCouleurStyle(c, {ref:id});
    if(col) st[o.a[0].ref] = col;
  });
  (c.P.parType.IFCMATERIALDEFINITIONREPRESENTATION || []).forEach(function(id){
    var o = E[id], mt = o.a[3];
    if(!mt || !mt.ref) return;
    (o.a[2] || []).forEach(function(r){
      var sr = igEnt(c, r);
      if(!sr || !sr.a[3]) return;
      sr.a[3].forEach(function(it){
        if(mat[mt.ref]) return;
        var col = igCouleurStyle(c, it);
        if(col) mat[mt.ref] = col;
      });
    });
  });
  c.styles = st; c.matCoul = mat;
}
/* la couleur que le matériau de l'ouvrage propose */
function igCouleurMateriau(c, idProduit, R){
  var assoc = R.matDe ? R.matDe[idProduit] : null;
  if(!assoc) return null;
  var E = c.E, vus = 0;
  var cherche = function(ref){
    var o = igEnt(c, ref);
    if(!o || ++vus > 30) return null;
    if(c.matCoul[o.id]) return c.matCoul[o.id];
    switch(o.type){
      case "IFCMATERIALLAYERSETUSAGE": return cherche(o.a[0]);
      case "IFCMATERIALLAYERSET":
        var L = o.a[0] || [];
        /* la couche extérieure d'abord : c'est elle qu'on voit */
        for(var i = 0; i < L.length; i++){ var r = cherche(L[i]); if(r) return r; }
        return null;
      case "IFCMATERIALLAYER": return cherche(o.a[0]);
      case "IFCMATERIALLIST":
        var L2 = o.a[0] || [];
        for(var j = 0; j < L2.length; j++){ var r2 = cherche(L2[j]); if(r2) return r2; }
        return null;
      case "IFCMATERIALCONSTITUENTSET": case "IFCMATERIALPROFILESET":
        var L3 = o.a[2] || [];
        for(var k = 0; k < L3.length; k++){ var r3 = cherche(L3[k]); if(r3) return r3; }
        return null;
      case "IFCMATERIALCONSTITUENT": return cherche(o.a[2]);
      case "IFCMATERIALPROFILE": return cherche(o.a[2]);
      case "IFCMATERIALPROFILESETUSAGE": return cherche(o.a[0]);
    }
    return null;
  };
  void E;
  return cherche({ref:assoc});
}

/* ---------------------------------------------------------------------
   107.5d · UN OUVRAGE ENTIER
   Sa représentation « Body » (ou la meilleure qui s'en approche), chaque
   élément avec sa couleur, puis les percements retranchés.
   --------------------------------------------------------------------- */
var IG_REP_CORPS = /^(Body|Facetation|Mesh|Surface)$/i;
var IG_REP_TYPES = /SweptSolid|Brep|Clipping|CSG|SurfaceModel|Tessellation|MappedRepresentation|SolidModel|AdvancedSweptSolid|AdvancedBrep/i;
function igRepresentationCorps(c, produit){
  var pds = igEnt(c, produit.a[6]);
  if(!pds || !pds.a[2]) return null;
  var choix = null, secours = null;
  pds.a[2].forEach(function(r){
    var sr = igEnt(c, r);
    if(!sr || sr.type !== "IFCSHAPEREPRESENTATION") return;
    var id = String(sr.a[1] || ""), ty = String(sr.a[2] || "");
    if(IG_REP_CORPS.test(id) && !choix) choix = sr;
    else if(IG_REP_TYPES.test(ty) && !/^(Axis|FootPrint|Box|Annotation|Profile|Reference)$/i.test(id) && !secours) secours = sr;
  });
  return choix || secours;
}
/* les éléments d'une représentation, aplatis : [{id de l'élément, matrice}] — les objets posés par
   référence (IfcMappedItem) sont suivis jusqu'à leurs vrais éléments */
function igElements(c, sr, M, coul, out, prof){
  if(!sr || (prof || 0) > 8) return;
  (sr.a[3] || []).forEach(function(r){
    var it = igEnt(c, r);
    if(!it) return;
    var col = c.styles[it.id] || coul || null;
    if(it.type === "IFCMAPPEDITEM"){
      var src = igEnt(c, it.a[0]);
      if(!src) return;
      var Mm = igMul(M, igMul(igOperateur(c, it.a[1]), igAxe(c, src.a[0])));
      igElements(c, igEnt(c, src.a[1]), Mm, col, out, (prof || 0) + 1);
      return;
    }
    out.push({id:it.id, M:M, c:col});
  });
}
/* tous les ouvrages du fichier, avec leur géométrie en mètres, repère du fichier */
var IG_SANS_VOLUME = {IFCOPENINGELEMENT:1, IFCSPACE:1, IFCGRID:1, IFCANNOTATION:1, IFCVIRTUALELEMENT:1,
  IFCBUILDINGSTOREY:1, IFCBUILDING:1, IFCPROJECT:1, IFCOPENINGSTANDARDCASE:1, IFCSPATIALZONE:1, IFCEXTERNALSPATIALELEMENT:1,
  IFCDISTRIBUTIONPORT:1, IFCALIGNMENT:1};
function igRelations(c){
  var E = c.E, P = c.P;
  var R = {perce:{}, hoteDe:{}, parties:{}, parent:{}, matDe:{}, contenu:{}, remplit:{}};
  (P.parType.IFCRELVOIDSELEMENT || []).forEach(function(id){
    var r = E[id];
    if(r.a[4] && r.a[4].ref && r.a[5] && r.a[5].ref){ (R.perce[r.a[4].ref] = R.perce[r.a[4].ref] || []).push(r.a[5].ref); R.hoteDe[r.a[5].ref] = r.a[4].ref; }
  });
  (P.parType.IFCRELFILLSELEMENT || []).forEach(function(id){
    var r = E[id];
    if(r.a[4] && r.a[4].ref && r.a[5] && r.a[5].ref) R.remplit[r.a[5].ref] = r.a[4].ref;
  });
  (P.parType.IFCRELAGGREGATES || []).concat(P.parType.IFCRELNESTS || []).forEach(function(id){
    var r = E[id];
    if(!r.a[4] || !r.a[4].ref) return;
    (r.a[5] || []).forEach(function(x){ if(x && x.ref){ (R.parties[r.a[4].ref] = R.parties[r.a[4].ref] || []).push(x.ref); R.parent[x.ref] = r.a[4].ref; } });
  });
  (P.parType.IFCRELASSOCIATESMATERIAL || []).forEach(function(id){
    var r = E[id];
    if(!r.a[5] || !r.a[5].ref) return;
    (r.a[4] || []).forEach(function(x){ if(x && x.ref && !R.matDe[x.ref]) R.matDe[x.ref] = r.a[5].ref; });
  });
  (P.parType.IFCRELCONTAINEDINSPATIALSTRUCTURE || []).forEach(function(id){
    var r = E[id];
    if(!r.a[5] || !r.a[5].ref) return;
    (r.a[4] || []).forEach(function(x){ if(x && x.ref) R.contenu[x.ref] = r.a[5].ref; });
  });
  return R;
}
/* le maillage d'un ouvrage : [{c:couleur, t:triangles monde (m), ferme}] */
function igMaillageProduit(c, R, o){
  var sr = igRepresentationCorps(c, o);
  if(!sr) return null;
  var Mo = igPlacement(c, o.a[5]);
  var elts = [];
  igElements(c, sr, IG_ID, null, elts, 0);
  if(!elts.length) return null;
  var defaut = igCouleurMateriau(c, o.id, R) || IG_COUL_CLASSE[o.type] || [0.75, 0.75, 0.75, 1];
  var parts = [];
  elts.forEach(function(e){
    var S = igSolide(c, {ref:e.id});
    if(!S || !S.t || !S.t.length) return;
    var t = e.M === IG_ID ? S.t : igTransformer(S.t, e.M);
    parts.push({c:e.c || defaut, t:t, ferme:S.ferme});
  });
  if(!parts.length) return null;
  /* LES PERCEMENTS. Chaque vide est exprimé dans le repère de l'ouvrage percé, puis retranché des
     parties fermées. Un vide qui ne traverse rien ne change rien. */
  var vides = R.perce[o.id];
  if(vides && vides.length){
    var Mi = igInv(Mo), creux = [];
    vides.forEach(function(vid){
      var ov = c.E[vid];
      if(!ov) return;
      var srv = igRepresentationCorps(c, ov);
      if(!srv) return;
      var Mv = igMul(Mi, igPlacement(c, ov.a[5])), ev = [];
      igElements(c, srv, IG_ID, null, ev, 0);
      ev.forEach(function(e){
        var S = igSolide(c, {ref:e.id});
        if(S && S.t && S.t.length && S.ferme) creux.push(igTransformer(S.t, igMul(Mv, e.M)));
      });
    });
    if(creux.length){
      /* TOUS LES VIDES D'UN COUP. Les retrancher un à un refaisait l'arbre du mur à chaque fois, et
         chaque découpe le morcelait davantage : un mur-rideau de Jean Zay, percé cent fois, dépassait
         la limite au vingtième trou. Des vides qui ne se touchent pas forment ensemble un solide
         valable : on les réunit en une seule soustraction. */
      parts.forEach(function(p){
        if(!p.ferme) return;
        var bp = igBoite(p.t), tous = [];
        creux.forEach(function(tv){
          var bv = igBoite(tv);
          if(bv[0] > bp[3] || bv[3] < bp[0] || bv[1] > bp[4] || bv[4] < bp[1] || bv[2] > bp[5] || bv[5] < bp[2]) return;
          for(var i = 0; i < tv.length; i++) tous.push(tv[i]);
        });
        if(!tous.length) return;
        if(p.t.length/9 > IG_CSG_MAX*3 || tous.length/9 > IG_CSG_MAX*3){ c.stats.csgEchecs++; return; }
        try { c.stats.csg++; p.t = igCsg(p.t, tous, "moins"); }
        catch(_e){ c.stats.csgEchecs++; }
      });
    }
  }
  parts.forEach(function(p){ p.t = igTransformer(p.t, Mo); });
  return parts.filter(function(p){ return p.t.length; });
}
/* L'ENSEMBLE DU FICHIER.
   `budget` borne le travail (secondes, triangles) : une maquette de 150 Mo ne doit pas figer
   l'atelier ; ce qui n'a pas été lu est compté et dit. */
function igLireGeometrie(P, budget){
  budget = budget || {};
  var t0 = Date.now(), maxS = budget.secondes || 40, maxTri = budget.triangles || 2500000;
  var c = igContexte(P), E = P.E;
  igIndexCouleurs(c);
  var R = igRelations(c);
  var objets = [], nTri = 0, coupe = false;
  var ids = [];
  Object.keys(P.parType).forEach(function(ty){
    if(IG_SANS_VOLUME[ty]) return;
    var l = P.parType[ty];
    if(!l.length) return;
    var o0 = E[l[0]];
    if(!o0 || !o0.a[6] || !o0.a[6].ref || !E[o0.a[6].ref] || E[o0.a[6].ref].type !== "IFCPRODUCTDEFINITIONSHAPE") return;
    l.forEach(function(id){ ids.push(id); });
  });
  ids.sort(function(a, b){ return a - b; });
  for(var k = 0; k < ids.length; k++){
    var o = E[ids[k]];
    if(!o || !o.a[6] || !o.a[6].ref) continue;
    /* un ensemble (escalier, toiture) dont les parties ont leur propre volume : on dessine les parties */
    var parts = R.parties[o.id];
    if(parts && parts.some(function(p){ return E[p] && E[p].a[6] && E[p].a[6].ref; })) continue;
    if(coupe || Date.now() - t0 > maxS*1000 || nTri > maxTri){ coupe = true; c.stats.coupe = (c.stats.coupe || 0) + 1; continue; }
    var M = null;
    try { M = igMaillageProduit(c, R, o); } catch(e){ c.stats.erreurs = (c.stats.erreurs || 0) + 1; M = null; }
    if(!M || !M.length){ c.stats.vides = (c.stats.vides || 0) + 1; continue; }
    var n = 0;
    M.forEach(function(p){ n += p.t.length/9; });
    nTri += n;
    var hote = R.remplit[o.id] !== undefined ? R.hoteDe[R.remplit[o.id]] : null;
    objets.push({id:o.id, ty:o.type, parts:M, n:n, par:R.parent[o.id] || null, hote:hote || null});
    c.stats.lus++;
  }
  /* UN TERRAIN QUI DESCEND JUSQU'AU NIVEAU DE LA MER. Certains exports de Revit extrudent le terrain
     depuis l'altitude NGF jusqu'à zéro : un bloc de 142 m sous un bâtiment de deux étages, qui
     écrase tout le cadrage. On le tranche trois mètres sous l'ouvrage le plus bas. */
  var zBas = Infinity;
  objets.forEach(function(o){
    if(o.ty === "IFCSITE" || o.ty === "IFCGEOGRAPHICELEMENT") return;
    o.parts.forEach(function(p){ var b = igBoite(p.t); if(b[2] < zBas) zBas = b[2]; });
  });
  if(isFinite(zBas)){
    var zCoupe = zBas - 3;
    objets.forEach(function(o){
      if(o.ty !== "IFCSITE" && o.ty !== "IFCGEOGRAPHICELEMENT") return;
      o.parts.forEach(function(p){
        var b = igBoite(p.t);
        if(b[2] >= zCoupe - 2) return;
        if(p.ferme && p.t.length/9 <= IG_CSG_MAX*3){
          var bl = [];
          igBoiteTri(bl, b[0] - 1, b[1] - 1, b[2] - 1, b[3] + 1, b[4] + 1, zCoupe);
          try { p.t = igCsg(p.t, bl, "moins"); c.stats.terrainTranche = (c.stats.terrainTranche || 0) + 1; return; } catch(_e){}
        }
        var t2 = [];
        for(var i = 0; i < p.t.length; i += 9)
          if(p.t[i+2] >= zCoupe || p.t[i+5] >= zCoupe || p.t[i+8] >= zCoupe) for(var k = 0; k < 9; k++) t2.push(p.t[i + k]);
        p.t = t2;
      });
      o.parts = o.parts.filter(function(p){ return p.t.length; });
    });
    objets = objets.filter(function(o){ return o.parts.length; });
  }
  nTri = 0;
  objets.forEach(function(o){ o.n = 0; o.parts.forEach(function(p){ o.n += p.t.length/9; }); nTri += o.n; });
  c.stats.tri = nTri;
  c.stats.ms = Date.now() - t0;
  c.stats.produits = ids.length;
  return {objets:objets, stats:c.stats, R:R, c:c};
}


/* ---- m13_ifc.js ---- */
/* ==================================================================================================
   DCE Educ — m13_ifc : la MAQUETTE NUMÉRIQUE IFC du projet, source unique de la 3D.
   La maquette n'est plus reconstruite depuis les plans PDF : on demande l'IFC au maître d'œuvre.
   · lecture (lecteur repris de l'Atelier Maquette, m12) : géométrie exacte de chaque ouvrage ;
   · modèle léger enregistré avec le projet : niveaux, ouvrages, familles (type Revit / ArchiCAD…),
     matériaux, quantités MESURÉES sur la géométrie (surface, volume, longueur, nombre), locaux ;
   · associations famille ↔ ouvrages / sous-ouvrages du CCTP et lignes du CDPGF : propositions
     automatiques (vocabulaire commun, épaisseurs), validées ou corrigées par l'élève.
   ================================================================================================== */
'use strict';
const IFCX = (() => {
  // classes IFC : libellé, unité de métré, mots du métier ajoutés pour l'association
  const CL = {
    IFCWALL: ['Mur, cloison', 'm²', 'MUR'], IFCWALLSTANDARDCASE: ['Mur, cloison', 'm²', 'MUR'], IFCWALLELEMENTEDCASE: ['Mur, cloison', 'm²', 'MUR'],
    IFCSLAB: ['Dalle, plancher', 'm²', 'DALLE PLANCHER'], IFCROOF: ['Toiture', 'm²', 'TOITURE COUVERTURE'], IFCCOVERING: ['Revêtement, plafond', 'm²', 'REVETEMENT'],
    IFCPLATE: ['Panneau, remplissage', 'm²', 'PANNEAU'], IFCCURTAINWALL: ['Mur-rideau', 'm²', 'MUR RIDEAU FACADE'], IFCMEMBER: ['Montant, traverse, limon', 'ml', 'MONTANT'],
    IFCDOOR: ['Porte', 'u', 'PORTE BLOC MENUISERIE'], IFCWINDOW: ['Fenêtre', 'u', 'FENETRE MENUISERIE CHASSIS'], IFCCOLUMN: ['Poteau', 'u', 'POTEAU'], IFCBEAM: ['Poutre', 'ml', 'POUTRE'],
    IFCRAILING: ['Garde-corps, main courante', 'ml', 'GARDE CORPS MAIN COURANTE'], IFCSTAIR: ['Escalier', 'u', 'ESCALIER'], IFCSTAIRFLIGHT: ['Volée d’escalier', 'u', 'ESCALIER VOLEE'],
    IFCRAMP: ['Rampe', 'u', 'RAMPE'], IFCRAMPFLIGHT: ['Rampe', 'u', 'RAMPE'], IFCFOOTING: ['Fondation', 'm³', 'FONDATION SEMELLE'], IFCPILE: ['Pieu', 'u', 'PIEU FONDATION'],
    IFCBUILDINGELEMENTPROXY: ['Objet', 'u', ''], IFCFURNISHINGELEMENT: ['Mobilier', 'u', 'MOBILIER'], IFCFLOWTERMINAL: ['Appareil (fluides)', 'u', 'APPAREIL'],
    IFCENERGYCONVERSIONDEVICE: ['Appareil de chauffage', 'u', 'CHAUFFAGE'], IFCFLOWSEGMENT: ['Conduit, canalisation', 'ml', 'CANALISATION'], IFCSITE: ['Terrain', 'm²', 'TERRAIN'],
    IFCTRANSPORTELEMENT: ['Ascenseur', 'u', 'ASCENSEUR'], IFCSHADINGDEVICE: ['Brise-soleil', 'u', 'BRISE SOLEIL']
  };
  const KEYCL = c => (c === 'IFCWALLSTANDARDCASE' || c === 'IFCWALLELEMENTEDCASE') ? 'IFCWALL' : c;
  // vocabulaire : un mot de la famille appelle les mots du CCTP
  const SYN = [
    [/PLATRE|PLACO|BA ?1[358]|STIL|PLAQUE/, 'PLATRE PLAQUE PLATRERIE'], [/CLOISON/, 'CLOISON DISTRIBUTION'], [/STIL|DOUBLAGE|CONTRE/, 'DOUBLAGE CONTRE CLOISON'], [/VOILE|B\.?A\b|BETON|BA \d/, 'BETON ARME VOILE GROS OEUVRE'],
    [/PANO BOIS|OSSATURE|PANNEAU BOIS|PANO/, 'OSSATURE BOIS MUR'], [/PANO|PANNEAU/, 'PANNEAU', 0.5], [/BARD/, 'BARDAGE', 0.6], [/ISOL/, 'ISOLATION ISOLANT THERMIQUE', 0.4], [/ACOUSTI/, 'ACOUSTIQUE', 0.6],
    [/ENDUIT|END\b|END\./, 'ENDUIT', 0.4], [/ZINC/, 'ZINC COUVERTURE'], [/TOIT/, 'TOITURE COUVERTURE'], [/CAISSON/, 'CAISSON TOITURE'], [/ETANCH/, 'ETANCHEITE', 0.6],
    [/PLAFOND|BAC BASCULANT|AQUAPANEL/, 'PLAFOND FAUX PLAFONDS SUSPENDU'], [/\bSOL\b|PLANCHER|DALLE/, 'PLANCHER DALLE'], [/CAILLEBOTIS/, 'CAILLEBOTIS'],
    [/VITR/, 'VITRAGE MENUISERIE MUR RIDEAU CHASSIS VITRE'], [/MENEAU/, 'MUR RIDEAU MENUISERIE ALUMINIUM'], [/ALU/, 'ALUMINIUM'], [/ACIER|METAL|CHS|PCC/, 'ACIER METALLIQUE METALLERIE SERRURERIE'],
    [/GRILLE/, 'GRILLE'], [/LIMON|ESCALIER|MARCHE|PAILLASSE|PALIER/, 'ESCALIER'], [/LAMELLE|BOIS/, 'BOIS'], [/CLOTURE|PORTAIL/, 'CLOTURE SERRURERIE'],
    [/RADIATEUR/, 'RADIATEUR CHAUFFAGE'], [/SOLAIRE|PHOTOVOLT/, 'PHOTOVOLTAIQUE MODULES PANNEAUX SOLAIRES'], [/BARREAUD/, 'BARREAUDAGE SERRURERIE'],
    [/LAVABO|VASQUE|WC|URINOIR|EVIER|DOUCHE/, 'APPAREILS SANITAIRES PLOMBERIE'], [/DORMANT ACIER/, 'HUISSERIE METALLIQUE'], [/TIERCE|VANTAI/, 'PORTE'],
    [/BSO|BRISE|LAME/, 'BRISE SOLEIL OCCULTATION'], [/LONGRINE/, 'LONGRINE FONDATION'], [/AGGLO|PARPAING|MACONN/, 'MACONNERIE BLOC']
  ];
  const STOP = new Set('DE DU DES LA LE LES ET EN AU AUX POUR SUR SOUS AVEC PAR UN UNE Y COMPRIS TYPE BASE DANS SELON OU PLUS LOT ARTICLE NOTA ENSEMBLE MISE OEUVRE FOURNITURE POSE TOUTES SUJETIONS COMPRIS CM MM'.split(' '));
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  // racine commune (pluriel, féminin) : « POTEAUX » = « POTEAU », « INTÉRIEURES » = « INTÉRIEUR »
  const stem = w => w.length > 4 ? w.replace(/[SX]$/, '').replace(/E$/, '') : w;
  const words = s => norm(s).replace(/[^A-Z0-9]+/g, ' ').split(' ').filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
  // épaisseurs et sections citées (en mm) : « 10cm », « 98mm », « 98/48 », « BA13 », « 200x200 »
  function dims(s) {
    const u = norm(s), out = new Set();
    u.replace(/(\d+(?:[.,]\d+)?)\s*CM\b/g, (_, v) => { out.add(Math.round(parseFloat(v.replace(',', '.')) * 10)); });
    u.replace(/(\d+(?:[.,]\d+)?)\s*MM\b/g, (_, v) => { out.add(Math.round(parseFloat(v.replace(',', '.')))); });
    u.replace(/\b(\d{2,3})\s*\/\s*\d{2,3}\b/g, (_, v) => { out.add(+v); });
    return out;
  }

  // ------------------------------------------------------------------ mesures sur la géométrie
  function measure(parts) {
    let S = 0, V = 0, Sup = 0, Sver = 0, x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
    parts.forEach(p => {
      const t = p.t;
      for (let i = 0; i < t.length; i += 9) {
        const ax = t[i], ay = t[i + 1], az = t[i + 2], bx = t[i + 3] - ax, by = t[i + 4] - ay, bz = t[i + 5] - az, cx = t[i + 6] - ax, cy = t[i + 7] - ay, cz = t[i + 8] - az;
        const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx, a2 = Math.hypot(nx, ny, nz), a = a2 / 2;
        S += a; if (a2 > 0) { const k = nz / a2; if (k > 0.35) Sup += a; else if (Math.abs(k) < 0.3) Sver += a; }
        if (p.ferme) V += (ax * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - ay * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) + az * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6;
        for (let k = 0; k < 9; k += 3) { const x = t[i + k], y = t[i + k + 1], z = t[i + k + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      }
    });
    return { S, V: Math.abs(V), Sup, Sver, b: [x0, y0, z0, x1, y1, z1] };
  }
  function qtyOf(cls, m) {
    const dx = m.b[3] - m.b[0], dy = m.b[4] - m.b[1], dz = m.b[5] - m.b[2];
    let A = m.S / 2, L = Math.max(dx, dy, dz);
    if (cls === 'IFCWALL') A = m.Sver / 2;
    else if (cls === 'IFCSLAB' || cls === 'IFCCOVERING' || cls === 'IFCROOF' || cls === 'IFCSITE') A = m.Sup;
    if (cls === 'IFCCOLUMN') L = dz; else if (cls === 'IFCRAILING') L = Math.hypot(dx, dy);
    return { A: +A.toFixed(3), V: +m.V.toFixed(4), L: +L.toFixed(3), H: +dz.toFixed(3) };
  }
  // contour au sol d'un local : arêtes de bord des triangles tournés vers le bas
  function footprint(parts) {
    const E = new Map(), key = (x, y) => Math.round(x * 1000) + ',' + Math.round(y * 1000), P = new Map();
    let A = 0;
    parts.forEach(p => { const t = p.t; for (let i = 0; i < t.length; i += 9) {
      const bx = t[i + 3] - t[i], by = t[i + 4] - t[i + 1], cx = t[i + 6] - t[i], cy = t[i + 7] - t[i + 1], nz = bx * cy - by * cx, n = Math.hypot(nz, (t[i + 4] - t[i + 1]) * (t[i + 8] - t[i + 2]) - (t[i + 5] - t[i + 2]) * cy, 0);
      const bz = t[i + 5] - t[i + 2], cz = t[i + 8] - t[i + 2], nx = by * cz - bz * cy, ny = bz * cx - bx * cz, L = Math.hypot(nx, ny, nz);
      if (!L || nz / L > -0.9) continue;
      A += L / 2;
      const v = [[t[i], t[i + 1]], [t[i + 3], t[i + 4]], [t[i + 6], t[i + 7]]];
      for (let k = 0; k < 3; k++) { const a = v[k], b = v[(k + 1) % 3], ka = key(...a), kb = key(...b), ek = ka < kb ? ka + '|' + kb : kb + '|' + ka; E.set(ek, (E.get(ek) || 0) + 1); P.set(ka, a); P.set(kb, b); }
    } });
    const nxt = new Map(); E.forEach((n, ek) => { if (n !== 1) return; const [a, b] = ek.split('|'); (nxt.get(a) || nxt.set(a, []).get(a)).push(b); (nxt.get(b) || nxt.set(b, []).get(b)).push(a); });
    const seen = new Set(), loops = [];
    nxt.forEach((_, s) => { if (seen.has(s)) return; const L = [s]; seen.add(s); let cur = s, prev = null, g = 0; for (;;) { const nb = (nxt.get(cur) || []).filter(x => x !== prev); const n = nb.find(x => !seen.has(x)); if (!n || g++ > 5000) break; seen.add(n); L.push(n); prev = cur; cur = n; } if (L.length >= 3) loops.push(L.map(k => P.get(k))); });
    const ar = o => { let s = 0; for (let i = 0, j = o.length - 1; i < o.length; j = i++) s += (o[j][0] + o[i][0]) * (o[j][1] - o[i][1]); return Math.abs(s / 2); };
    loops.sort((p, q) => ar(q) - ar(p));
    return { A, o: loops[0] || null };
  }

  // ------------------------------------------------------------------ lecture complète
  let RT = null;     // en mémoire seulement : fichier analysé, géométrie, correspondances
  async function read(text, nom, log = () => {}) {
    const tick = () => new Promise(r => setTimeout(r, 0));
    log('Maquette IFC : analyse du fichier…'); await tick();
    const P = ifcAnalyser(text);
    log('  ' + Object.keys(P.E).length.toLocaleString('fr-FR') + ' entités · ' + (P.schema || '?') + ' · ' + (P.emetteur || 'logiciel inconnu')); await tick();
    log('Maquette IFC : géométrie des ouvrages…'); await tick();
    const G = igLireGeometrie(P, { secondes: 240, triangles: 6e6 });
    log('  ' + G.objets.length + ' ouvrages, ' + G.stats.tri.toLocaleString('fr-FR') + ' triangles, ' + (G.stats.csg || 0) + ' percements' + (G.stats.coupe ? ' — ' + G.stats.coupe + ' ouvrages non lus (budget dépassé)' : ''));
    await tick();
    const M = model(P, G, nom, text.length);
    RT = { P, G, nom, size: text.length, M };
    log('  ' + M.levels.length + ' niveaux, ' + Object.keys(M.fams).length + ' familles d’ouvrages, ' + M.spaces.length + ' locaux');
    return M;
  }
  function model(P, G, nom, size) {
    const I = ifcIndexDonnees(P), U = ifcUnitesProjet(P), R = G.R, E = P.E, m = G.c.m;
    // ---- niveaux : les niveaux auxiliaires (à moins d'un mètre) rejoignent le niveau principal le plus garni
    const st = (P.parType.IFCBUILDINGSTOREY || []).map(id => ({ id, nom: ifcTexte(E[id].a[2]) || ifcTexte(E[id].a[7]) || 'Niveau', z: igNum(E[id].a[9]) * m, n: 0 })).sort((a, b) => a.z - b.z);
    const storeyOf = id => { let k = id, g = 0; while (k != null && g++ < 8) { const e = E[k]; if (e && e.type === 'IFCBUILDINGSTOREY') return k; if (R.contenu[k] != null) return R.contenu[k]; k = R.parent[k]; } return null; };
    const sOf = {}; G.objets.forEach(o => { const s = storeyOf(o.id); sOf[o.id] = s; const x = st.find(q => q.id === s); if (x) x.n++; });
    const grp = []; st.forEach(s => { const g = grp[grp.length - 1]; if (g && s.z - g[0].z < 1.0) g.push(s); else grp.push([s]); });
    const levels = [], levOfStorey = {};
    grp.forEach(g => { const pr = g.slice().sort((a, b) => b.n - a.n)[0]; if (!g.some(s => s.n)) return; const k = levels.length; levels.push({ nom: cleanName(pr.nom), z: +pr.z.toFixed(3), ifc: g.map(s => s.nom) }); g.forEach(s => { levOfStorey[s.id] = k; }); });
    if (!levels.length) levels.push({ nom: 'Niveau 0', z: 0, ifc: [] });
    levels.forEach((L, i) => { const nx = levels[i + 1]; L.h = nx ? +(nx.z - L.z).toFixed(2) : 3; });
    const levOf = id => { const s = sOf[id] != null ? sOf[id] : storeyOf(id); return levOfStorey[s] != null ? levOfStorey[s] : 0; };
    // ---- repère : centre de l'emprise des ouvrages (terrain exclu), plan = (X, −Y)
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    G.objets.forEach(o => { if (o.ty === 'IFCSITE') return; o.parts.forEach(p => { const b = igBoite(p.t); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[3]); y1 = Math.max(y1, b[4]); }); });
    const O = [(x0 + x1) / 2, (y0 + y1) / 2], pl = (x, y) => [+(x - O[0]).toFixed(3), +(-(y - O[1])).toFixed(3)];
    // ---- ouvrages et familles
    const el = [], fams = {};
    G.objets.forEach((o, k) => {
      const e = E[o.id], a = e.a, par = R.parent[o.id];
      // une dalle de toiture (partie d'un IfcRoof, type « Toit… » ou .ROOF.) est une toiture, pas un plancher
      let cls = KEYCL(o.ty); if (cls === 'IFCSLAB' && ((par != null && E[par] && E[par].type === 'IFCROOF') || /^TOIT/.test(norm(ifcTexte(a[4]))) || a[8] === '.ROOF.')) cls = 'IFCROOF';
      const tid = I.typeDe[o.id] != null ? I.typeDe[o.id] : (par != null ? I.typeDe[par] : null);
      const ot = ifcTexte(a[4]) || (par != null ? ifcTexte(E[par].a[4]) : ''), tn = tid != null ? ifcTexte(E[tid].a[2]) : '';
      // famille:type, sans l'identifiant final ni le numéro d'exemplaire (« ferme treillis préau15 » = « ferme treillis préau »)
      let fam = (ot || tn || ifcTexte(a[2]) || '').replace(/:\d+$/, '').replace(/\s+\d+(?=:|$)/g, '').replace(/([a-zà-ÿ])\d+(?=:|$)/g, '$1').trim() || '(sans type)';
      if (o.ty === 'IFCSITE') fam = 'Terrain';
      const mid = I.mat[o.id] != null ? I.mat[o.id] : par != null && I.mat[par] != null ? I.mat[par] : tid != null ? I.mat[tid] : null;
      const MM = mid != null ? ifcMateriaux(P, mid, U) : { c: [] }, mats = [...new Set(MM.c.map(x => x[0]).filter(Boolean))];
      const ms = measure(o.parts), q = qtyOf(cls, ms);
      const key = cls + '|' + fam, lev = levOf(o.id);
      const parCls = par != null && E[par] ? E[par].type : null;
      el.push({ id: o.id, g: ifcTexte(a[0]), c: o.ty, n: ifcTexte(a[2]), f: key, lev, m: mats, q, pc: parCls });
      const F = fams[key] || (fams[key] = { c: cls, fam, lab: fam.includes(':') ? fam.split(':').slice(1).join(':') : fam, fa: fam.includes(':') ? fam.split(':')[0] : '', cf: (CL[cls] || [ifcNomClasse(cls)])[0], u: (CL[cls] || ['', 'u'])[1], n: 0, A: 0, V: 0, L: 0, m: new Set(), levs: new Set(), par: parCls });
      F.n++; F.A += q.A; F.V += q.V; F.L += q.L; F.S = (F.S || 0) + ms.S; mats.forEach(x => F.m.add(x)); F.levs.add(lev);
    });
    Object.values(fams).forEach(F => { F.A = +F.A.toFixed(2); F.S = +(F.S || 0).toFixed(2); F.V = +F.V.toFixed(3); F.L = +F.L.toFixed(2); F.m = [...F.m]; F.levs = [...F.levs].sort(); F.ent = /^RPC\b|PERSONNE|PEOPLE|ARBRE|TREE|PLANT|VEGETA|ENTOURAGE|VOITURE|CAR\b/.test(norm(F.fam)) || F.c === 'IFCSITE'; });
    // ---- locaux (IfcSpace) : nom, surface au sol mesurée, contour
    const spaces = [];
    (P.parType.IFCSPACE || []).forEach(id => {
      const e = E[id]; let parts = null; try { parts = igMaillageProduit(G.c, G.R, e); } catch (er) { parts = null; }
      if (parts && parts.length) (G.spaces || (G.spaces = new Map())).set(id, parts);       // volumes des locaux, pour la 3D (en mémoire)
      const fp = parts && parts.length ? footprint(parts) : { A: 0, o: null }, ms = parts && parts.length ? measure(parts) : null;
      spaces.push({ id, num: ifcTexte(e.a[2]), n: ifcTexte(e.a[7]) || ifcTexte(e.a[2]) || 'Local', lev: levOf(id), a: +fp.A.toFixed(2), o: fp.o ? fp.o.map(p => pl(p[0], p[1])) : null, h: ms ? +(ms.b[5] - ms.b[2]).toFixed(2) : null });
    });
    return { nom, size, schema: P.schema || '', emetteur: P.emetteur || '', O, levels, el, fams, spaces, date: new Date().toISOString().slice(0, 10) };
  }
  const cleanName = s => String(s || '').replace(/\s*[-–]?\s*1\s*[-/]\s*\d+\s*[eéè]?me\b.*$/i, '').replace(/^\d+(-\d+)?\s*-\s*/, '').replace(/\s*\(\s*[±+\-]?\s*\d+[.,]\d+(\s*=\s*[\d.,]+)?\s*\)\s*$/, '').trim() || s;

  // ------------------------------------------------------------------ projet DCE Educ à partir de la maquette
  function project(M, Pj) {
    Pj.source = 'ifc';
    Pj.ifc = M;
    Pj.levels = M.levels.map((L, i) => ({ id: i, nom: L.nom, n: i, z: L.z, h: L.h, slab: 0.25, src: 'IFC', align: 'maquette', piece: M.nom, ifc: L.ifc }));
    Pj.rooms = M.spaces.map((s, k) => ({ id: 'S' + s.lev + '.' + String(k + 1).padStart(3, '0'), lev: s.lev, n: s.n, num: s.num, a: s.a || null, am: s.a || 0, hs: s.h ? ['HSP', s.h] : null, ext: false, fid: 'ifc', polys: s.o ? [s.o] : [], ifc: s.id }));
    ['walls', 'open', 'cols', 'fp', 'roofs', 'stairs'].forEach(k => { Pj[k] = []; });
    Pj.wtypes = {}; Pj.alt = Pj.alt || null; Pj.notes = Pj.notes || [];
    return Pj;
  }

  // ------------------------------------------------------------------ associations famille ↔ CCTP / CDPGF
  const artKey = (lot, num) => lot + ':' + num, lineKey = (lot, i) => lot + ':' + i;
  // poids des mots d'une famille : son nom et son type (1), les mots du métier qu'ils appellent (1),
  // la classe IFC (1,5), les matériaux (0,35 : une couleur « gris métallisé » ne fait pas une porte métallique)
  function famTokens(F) {
    const W = new Map(), add = (s, w) => words(s).forEach(x => W.set(x, Math.max(W.get(x) || 0, w)));
    const name = F.fam.replace(/^Mur de base:|^Sol:|^Plafond composé:|^Panneau système:/i, ' ') + ' ' + F.fam.replace(/\bINT\./i, 'intérieur ').replace(/\bEXT\./i, 'extérieur ');
    add(name, 1); const u = norm(name);
    SYN.forEach(([re, w, k]) => { if (re.test(u)) add(w, k || 1); });
    if (CL[F.c]) add(CL[F.c][2], 1.5);
    if (F.c === 'IFCWALL' && /PLATRE|CLOISON|BA ?1|STIL|PLACO/.test(u) && !/VOILE|BETON/.test(u)) W.delete(stem('MUR'));
    const mu = norm(F.m.join(' ')); add(F.m.join(' '), 0.35); SYN.forEach(([re, w]) => { if (re.test(mu)) words(w).forEach(x => { if (!W.has(x)) W.set(x, 0.35); }); });
    return W;
  }
  // l'ouvrage que désigne un titre (ou une famille) : un article « PORTE … » n'est pas un poteau
  const HEADS = [['porte', /\b(PORT|BLOC PORT|VANTAIL|HUISSERI)/], ['fenetre', /\b(FENETR|CHASSI|BAIE\b)/], ['poteau', /\bPOTEAU/], ['poutre', /\b(POUTR|LINTEAU|CONSOL)/],
    ['plancher', /\b(PLANCHER|DALL|PREDALL)/], ['mur', /\b(MUR\b(?! RIDEAU)|VOIL\b|VOILE|OSSATUR|PAROI)/], ['cloison', /(?<!CONTRE )\bCLOISON/], ['doublage', /\b(DOUBLAG|CONTRE CLOISON|STIL)/], ['plafond', /\bPLAFOND/], ['couverture', /\b(COUVERTUR|TOITUR|ETANCHEIT|ZINC)/],
    ['escalier', /\b(ESCALI|MARCH|LIMON)/], ['gardecorps', /\b(GARD CORP|MAIN COURANT|BARREAUDAG)/], ['murrideau', /\b(MUR RIDEAU|VITRAG|MENEAU)/], ['pv', /\b(PHOTOVOLTA|MODUL|SOLAIR)/],
    ['sol', /\b(CARRELAG|REVETEMENT SOL|SOL SOUPL|CHAP)/], ['cloture', /\b(CLOTUR|PORTAIL)/], ['chauffage', /\b(RADIATEUR|CHAUFF)/], ['sanitaire', /\b(LAVABO|WC\b|URINOIR|SANITAIR)/]];
  const heads = s => { const u = ' ' + [...(s instanceof Map ? s.keys() : s)].join(' ') + ' '; return new Set(HEADS.filter(([, re]) => re.test(u)).map(([k]) => k)); };
  function articleIndex(Pj) {
    const A = [];
    (Pj.cctp || []).forEach(c => {
      const arts = c.articles || [], tit = {}; arts.forEach(a => { tit[a.num] = a.titre || ''; });
      // ouvrages chiffrés : numéros d'article portés par les lignes du CDPGF du lot
      const d = (Pj.dpgf || []).find(x => x.lot === c.lot), pr = new Set(d ? d.lignes.flatMap(l => [l.art, l.num]).filter(Boolean) : []);
      const priced = num => { if (pr.has(num)) return true; const par = num.split('.').slice(0, -1).join('.'); if (par && pr.has(par)) return true; for (const x of pr) if (String(x).startsWith(num + '.')) return true; return false; };
      arts.forEach(a => {
        const anc = []; const parts = String(a.num || '').split('.'); for (let k = 1; k < parts.length; k++) { const p = parts.slice(0, k).join('.'); if (tit[p]) anc.push(tit[p]); }
        A.push({ key: artKey(c.lot, a.num), lot: c.lot, num: a.num, titre: a.titre || '', depth: parts.length, pr: d ? priced(String(a.num || '')) : null, sec: /PARTICULIER|TRAITEMENT|SUJETION|ACCESSOIRE|SORTIE|RACCORD|PLU[SE].?VALUE|TRAPPE|RELEVE|CALFEUTR|HABILLAGE DE LA|REPRISE/.test(norm(a.titre)), com: /^0+$/.test(c.lot) || /COMMUN|GENERALIT|PRESCRIPTIONS? GEN/.test(norm(c.titre)), T: new Set(words(a.titre)), H: (h => h.size ? h : heads(words(anc.slice(-2).join(' '))))(heads(words(a.titre))), N: new Set(words(anc.join(' '))), L: new Set(words(c.titre || '')), X: new Set(words(String(a.texte || '').slice(0, 700))), D: dims((a.titre || '') + ' ' + String(a.texte || '').slice(0, 700)) });
      });
    });
    const df = new Map(); A.forEach(a => new Set([...a.T, ...a.N]).forEach(w => df.set(w, (df.get(w) || 0) + 1)));
    const idf = w => Math.log(1 + A.length / (1 + (df.get(w) || 0)));
    return { A, idf };
  }
  function scoreArt(W, D, H, a, idf) {
    let s = 0, st = 0, hit = 0;
    W.forEach((wt, w) => { const i = idf(w) * wt; if (a.T.has(w)) { st += 3 * i; hit++; } else if (a.N.has(w)) s += 1.3 * i; else if (a.X.has(w)) s += 0.25 * i; if (a.L.has(w)) s += 0.8 * i; });
    // un titre presque entièrement couvert par la famille vaut mieux qu'un long titre qui n'en partage que deux mots
    s += st * (0.4 + 0.6 * Math.min(1, hit / Math.max(1, a.T.size)));
    D.forEach(d => { for (const e of a.D) if (Math.abs(e - d) <= Math.max(2, 0.05 * d)) { s += 3; break; } });
    // même ouvrage désigné : bonus ; ouvrage différent : forte pénalité
    if (a.com) s *= 0.4;                                 // prescriptions communes (lot 00, généralités) : pas un ouvrage
    if (a.pr === true) s *= 1.5; else if (a.pr === false) s *= 0.65;   // un ouvrage chiffré au CDPGF, plutôt qu'une prescription générale
    if (a.sec) s *= 0.75;                                // ouvrage secondaire (« ouvrages particuliers », « traitement des sorties »…)
    const Ha = a.H; if (H.size && Ha.size) { let same = false; H.forEach(h => { if (Ha.has(h)) same = true; }); s *= same ? 1.4 : 0.3; } else if (H.size) s *= 0.75;
    return s;
  }
  function suggest(Pj, F) {
    const IX = Pj._ix || (Object.defineProperty(Pj, '_ix', { value: articleIndex(Pj), enumerable: false, configurable: true }), Pj._ix);
    const W = famTokens(F), D = dims(F.fam), H = heads(new Map([...W].filter(([, w]) => w >= 1)));
    const S = IX.A.map(a => ({ a, s: scoreArt(W, D, H, a, IX.idf) })).filter(x => x.s > 0).sort((p, q) => q.s - p.s || q.a.depth - p.a.depth);
    return S.slice(0, 8).map(x => ({ key: x.a.key, s: +x.s.toFixed(1), lot: x.a.lot, num: x.a.num, titre: x.a.titre }));
  }
  // lignes du CDPGF rattachées à un article (numéro d'article porté par la ligne, ou même libellé) ;
  // un sous-ouvrage non chiffré à part se rattache aux lignes de son ouvrage parent
  function linesOfArt(Pj, key, up = 2) {
    const [lot, num] = key.split(':'), out = [], d = (Pj.dpgf || []).find(x => x.lot === lot); if (!d) return out;
    const art = ((Pj.cctp || []).find(c => c.lot === lot) || { articles: [] }).articles.find(a => a.num === num), T = art ? norm(art.titre).replace(/[^A-Z0-9]+/g, ' ').trim() : '';
    d.lignes.forEach((l, i) => {
      if (!((l.art && l.art === num) || (l.num && l.num === num) || (T && T.length > 8 && norm(l.des).replace(/[^A-Z0-9]+/g, ' ').trim() === T))) return;
      out.push(lineKey(lot, i));
      // ses lignes de détail sans numéro (béton, coffrage, armatures…)
      for (let j = i + 1; j < d.lignes.length && !d.lignes[j].num && j <= i + 12; j++) if (d.lignes[j].u) out.push(lineKey(lot, j));
    });
    if (!out.length && up > 0 && num.includes('.')) return linesOfArt(Pj, lot + ':' + num.split('.').slice(0, -1).join('.'), up - 1);
    return [...new Set(out)];
  }
  // propositions pour toutes les familles ; les meilleures, assez sûres, sont associées d'office (« proposé »)
  function autoAssoc(Pj, opts = {}) {
    const AS = Pj.assoc = Pj.assoc || {};
    Object.entries(Pj.ifc.fams).forEach(([k, F]) => {
      if (AS[k] && AS[k].ok) return;                  // validé par l'élève : on n'y touche plus
      if (F.ent) { AS[k] = { arts: [], lignes: [], auto: true, sans: true }; return; }
      const S = suggest(Pj, F), best = S[0];
      const arts = best && best.s >= (opts.seuil || 14) ? [best.key] : [];
      AS[k] = { arts, lignes: arts.flatMap(a => linesOfArt(Pj, a)), auto: true };
    });
    return AS;
  }
  // quantité d'une famille dans l'unité d'une ligne de CDPGF
  function famQty(F, u, des) {
    u = String(u || '').toLowerCase().replace(/\s/g, '');
    if (/^kg$|^t$/.test(u)) return { q: null, how: '' };                      // armatures : non mesurables sur la maquette
    // coffrage : les deux faces d'un voile, le tour d'un poteau ou d'une poutre
    if (/^m[²2]$/.test(u) && /COFFRAGE/.test(norm(des))) return F.c === 'IFCWALL' ? { q: +(2 * F.A).toFixed(2), how: 'surface coffrée (deux faces)' } : F.S != null ? { q: +(F.c === 'IFCBEAM' ? F.S * 0.8 : F.S).toFixed(2), how: 'surface coffrée (≈ surface des faces)' } : { q: null, how: '' };
    if (/^m[²2]$/.test(u)) return { q: F.A, how: 'surface mesurée' };
    if (/^m[³3]$/.test(u)) return { q: F.V, how: 'volume mesuré' };
    if (/^(ml|m)$/.test(u)) return { q: F.c === 'IFCWALL' ? null : F.L, how: 'longueur mesurée' };
    if (/^(u|un|unite|nb|ens|pce|pc|ft)$/.test(u)) return { q: F.n, how: 'nombre d’ouvrages' };
    return { q: null, how: '' };
  }
  // article d'une ligne : le sien, ou celui de la ligne numérotée qu'elle détaille (« Béton », « Coffrage », « Armatures »)
  function lineArtOf(d, i) { for (let j = i; j >= 0 && j >= i - 12; j--) { const l = d.lignes[j]; if (l.num) return l.art || l.num; } return null; }
  const PRC = new WeakMap();
  const pricedOf = d => PRC.get(d) || (PRC.set(d, new Set(d.lignes.filter(l => l.num).map(l => l.art || l.num))), PRC.get(d));
  // ligne chiffrée la plus proche d'un article : lui-même, sinon son parent, sinon son grand-parent…
  function nearestPriced(set, num) { let x = String(num || ''); while (x) { if (set.has(x)) return x; const p = x.split('.'); p.pop(); x = p.join('.'); } return null; }
  // familles associées à une ligne : rattachées à la main, ou dont l'article a cette ligne pour ligne chiffrée la plus proche
  // (une famille ne compte pas pour un chapitre dont le sous-article est chiffré à part)
  function famsOfLine(Pj, lot, i) {
    const d = (Pj.dpgf || []).find(x => x.lot === lot); if (!d) return [];
    const k = lineKey(lot, i), ak = lineArtOf(d, i), set = pricedOf(d);
    return Object.entries(Pj.assoc || {}).filter(([fk, a]) => !a.sans && ((a.lignes || []).includes(k) || (ak && (a.arts || []).some(x => { const [lt, num] = x.split(':'); return lt === lot && nearestPriced(set, num) === ak; })))).map(([fk]) => fk);
  }
  function famsOfArt(Pj, key) { const pre = key + '.'; return Object.entries(Pj.assoc || {}).filter(([, a]) => !a.sans && (a.arts || []).some(x => x === key || x.startsWith(pre))).map(([fk]) => fk); }
  // fiche complète d'un ouvrage (propriétés du fichier), si la maquette est en mémoire
  // jeux de propriétés d'un ouvrage (et de son type) : [{nom, l:[[propriété, valeur, unité]]}]
  function fiche(id) {
    if (!RT) return null;
    const P = RT.P, I = RT.I || (RT.I = ifcIndexDonnees(P)), U = RT.U || (RT.U = ifcUnitesProjet(P)), out = [];
    try {
      (I.defs[id] || []).forEach(d => { const s = ifcLireDefinition(P, d, U); if (s) out.push(s); });
      const t = I.typeDe[id]; if (t != null && P.E[t]) (P.E[t].a[5] || []).forEach(r => { const s = r && r.ref ? ifcLireDefinition(P, r.ref, U) : null; if (s) out.push(Object.assign(s, { nom: s.nom + ' (type)' })); });
    } catch (e) { }
    return out;
  }
  return { read, model, project, suggest, autoAssoc, linesOfArt, famQty, famsOfLine, famsOfArt, fiche, artKey, lineKey, norm, CL, get RT() { return RT; }, set RT(v) { RT = v; } };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = IFCX;

/* ---- m5_projet.js ---- */
/* ==================================================================================================
   DCE Educ — m5_projet : assemblage du projet à partir des pièces lues
   niveaux recalés, altitudes, toitures par défaut, liens CCTP ↔ locaux ↔ DPGF, métré de la maquette
   ================================================================================================== */
'use strict';
const PROJ = (() => {
  const norm = PDFX.norm;
  const area2 = r => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
  const perim = r => { let L = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; L += Math.hypot(q[0] - p[0], q[1] - p[1]); } return L; };
  const bbox = pts => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; pts.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }); return { x0, y0, x1, y1 }; };

  // ------------------------------------------------------------------ assemblage
  // pieces : [{file, doc, cls, items, page}] ; renvoie le projet
  async function assemble(pieces, log = () => {}, opts = {}) {
    const canop = [], stairL = [];
    const P = { version: 1, nom: '', date: new Date().toISOString().slice(0, 10), pieces: [], levels: [], rooms: [], walls: [], open: [], cols: [], fp: [], wtypes: {}, roofs: [], stairs: [], cctp: [], dpgf: [], alt: null, notes: [] };
    P.pieces = pieces.map(p => ({ nom: p.file.name, kind: p.cls.kind, lot: p.cls.lot || null, level: p.cls.level ? p.cls.level.name : null, scale: p.cls.scale, pages: p.doc.numPages, partial: !!p.cls.partial, used: false }));
    // nom du projet : texte le plus gros récurrent des cartouches
    const big = pieces.filter(p => p.items).flatMap(p => p.items.filter(t => /[A-Z]{4,}.*[A-Z]{3,}/.test(t.s) && t.s.length > 12 && t.s.length < 60)).sort((a, b) => b.size - a.size);
    const cnt = new Map(); big.slice(0, 120).forEach(t => cnt.set(t.s.trim(), (cnt.get(t.s.trim()) || 0) + 1));
    P.nom = ([...cnt].sort((a, b) => b[1] - a[1])[0] || ['Projet'])[0];
    // ---------- plans de niveau : un par niveau (le plus complet)
    const plans = pieces.filter(p => p.cls.kind === 'plan' && p.cls.level && !p.skip);
    const byLev = new Map();
    plans.forEach(p => { const k = p.cls.level.n; const cur = byLev.get(k); const score = p.cls.areas - (p.cls.partial ? 1000 : 0); if (!cur || score > cur.score) byLev.set(k, { p, score }); });
    const levs = [...byLev.keys()].sort((a, b) => a - b);
    if (!levs.length) { P.notes.push({ k: 'erreur', t: 'Aucun plan de niveau reconnu : déposez les plans (avec étiquettes de surfaces) en PDF vectoriel.' }); return P; }
    const reads = [];
    for (const n of levs) {
      const pc = byLev.get(n).p; P.pieces.find(x => x.nom === pc.file.name).used = true;
      log('Lecture du plan ' + pc.cls.level.name + ' (' + pc.file.name + ')…');
      let L = await PLAN.read(pc.page, pc.items, { scale: pc.cls.scale || 100 }, m => log(pc.cls.level.name + ' — ' + m));
      // échelle douteuse : surfaces relevées trop loin des surfaces DCE
      if (L.rooms.length >= 4 && (L.medRatio < 0.45 || L.medRatio > 2.2)) {
        const sc2 = Math.round((pc.cls.scale || 100) * Math.sqrt(L.medRatio));
        const std = [20, 25, 50, 75, 100, 125, 150, 200, 250, 500].reduce((a, b) => Math.abs(b - sc2) < Math.abs(a - sc2) ? b : a);
        P.notes.push({ k: 'echelle', t: `${pc.cls.level.name} : l'échelle annoncée (1/${pc.cls.scale}) ne colle pas aux surfaces des étiquettes ; relu au 1/${std}.` });
        pc.cls.scale = std; L = await PLAN.read(pc.page, pc.items, { scale: std }, m => log(pc.cls.level.name + ' — ' + m));
      }
      reads.push({ n, pc, L });
    }
    // ---------- recalage des niveaux sur le niveau le plus bas
    const ref = reads[0];
    reads.forEach(r => {
      r.dx = 0; r.dy = 0;
      if (r === ref) return;
      const off = PLAN.alignOffset(ref.pc.items, r.pc.items);
      if (off && Math.abs(r.L.ptPerM - ref.L.ptPerM) < 1e-6) { r.dx = off.dx / r.L.ptPerM; r.dy = off.dy / r.L.ptPerM; r.align = 'repères de grille (' + off.n + ')'; }
      else { const o = overlapAlign(ref.L.fp, r.L.fp); r.dx = o.dx; r.dy = o.dy; r.align = 'emprises superposées'; P.notes.push({ k: 'recalage', t: r.pc.cls.level.name + ' recalé sur les emprises (pas de repères de grille communs) : à vérifier.' }); }
    });
    // origine : coin des emprises du niveau de référence
    const allFp = ref.L.fp.flatMap(f => f.o);
    const B = bbox(allFp.length ? allFp : [[0, 0], [1, 1]]), OX = B.x0 - 2, OY = B.y0 - 2;
    const tr = (r, p) => [+(p[0] + r.dx - OX).toFixed(3), +(p[1] + r.dy - OY).toFixed(3)];
    // ---------- altitudes
    const altItems = pieces.filter(p => ['coupe', 'facade', 'masse'].includes(p.cls.kind) && p.items).flatMap(p => p.items);
    const A = PLAN.altitudes(altItems); P.alt = { ngf: A.ngf, sf: [...new Set(A.sf)].sort((a, b) => a - b), egout: Math.max(...A.egout, -99), faitage: Math.max(...A.faitage, -99), acrotere: Math.max(...A.acrotere, -99), pente: A.pente };
    const sfPos = [...new Set(A.sf.concat(A.all.filter(v => v > 2.3 && v < 4.5 * levs.length)))].filter(v => v > 2.3).sort((a, b) => a - b);
    reads.forEach((r, i) => {
      let z = 0, src = 'plan';
      if (r.n === 0) z = 0;
      else if (r.pc.cls.alt != null) z = r.pc.cls.alt;
      else if (r.n > 0 && sfPos.length >= r.n) { z = sfPos.filter(v => v > 2.3)[r.n - 1]; src = 'coupes'; }
      else { z = 3.0 * r.n; src = 'hyp'; }
      P.levels.push({ id: i, nom: r.pc.cls.level.name, n: r.n, z, h: 3.0, slab: 0.25, src, align: r.align || 'référence', piece: r.pc.file.name, scale: r.pc.cls.scale, legend: r.L.legend });
    });
    P.levels.forEach((L, i) => { const nx = P.levels[i + 1]; if (nx) { L.h = +(nx.z - L.z).toFixed(2); L.hsrc = nx.src; } });
    const top = P.levels[P.levels.length - 1];
    const roofTop = [P.alt.acrotere, P.alt.egout].filter(v => v > top.z + 2 && v < top.z + 8);
    top.h = roofTop.length ? +(Math.max(...roofTop) - top.z).toFixed(2) : 3.0; top.hsrc = roofTop.length ? 'coupes' : 'hyp';
    // ---------- géométries dans le repère commun
    let rid = 0;
    reads.forEach((r, i) => {
      const L = r.L;
      Object.assign(P.wtypes, Object.fromEntries(L.types.map(t => [t.key, { nom: t.nom, kind: t.kind, rgb: t.rgb }])));
      L.rooms.forEach(o => {
        const e = o.a ? Math.abs(o.am / o.a - 1) : null;
        P.rooms.push({ id: (r.n >= 0 ? 'R' + r.n : 'S' + (-r.n)) + '.' + String(++rid).padStart(3, '0'), lev: i, n: o.n, a: o.a, am: o.am, hs: o.hs, ext: o.ext, noname: o.noname, l: o.lx != null ? tr(r, [o.lx, o.ly]) : null,
          fid: e == null ? 'deduit' : e <= 0.15 ? 'bon' : e <= 0.3 ? 'moyen' : 'faible', polys: o.polys.map(Q => Q.map(p => tr(r, p))) });
      });
      // murs « métier » : axe (a → b), épaisseur, type de la légende, en façade ou non ; le contour (o) sert aux anciens calculs
      L.walls.forEach(w => P.walls.push({ lev: i, t: w.t, o: w.o.map(p => tr(r, p)), h: (w.h || []).map(Q => Q.map(p => tr(r, p))), a: w.a ? tr(r, w.a) : null, b: w.b ? tr(r, w.b) : null, th: w.th || null, ext: !!w.ext }));
      L.open.forEach(o => P.open.push({ lev: i, c: tr(r, o.c), w: o.w, t: o.t, a: o.a, ext: o.ext, kind: o.kind || (o.ext ? 'fenetre' : 'porte'), full: !!o.full, ref: o.ref || null, h: o.h || null, wref: o.wref || null, hsrc: o.hsrc || 'hyp', door: o.door || null,
        ends: o.ends ? o.ends.map(p => tr(r, p)) : null, hinge: o.hinge ? tr(r, o.hinge) : null, swing: o.swing ? tr(r, o.swing) : null }));
      L.cols.forEach(o => P.cols.push({ lev: i, c: tr(r, o.c), d: o.d }));
      L.fp.forEach(f => P.fp.push({ lev: i, o: f.o.map(p => tr(r, p)), area: f.area }));
      (L.stairs || []).forEach(s => stairL.push({ lev: i, guess: s.guess, runs: s.runs.map(x => Object.assign({}, x, { q: x.q.map(p => tr(r, p)) })), lands: s.lands.map(q => q.map(p => tr(r, p))) }));
      (L.canopies || []).forEach(c => canop.push(Object.assign({}, c, { lev: i, o: c.o.map(p => tr(r, p)), posts: c.posts.map(p => tr(r, p)) })));
    });
    pruneUpper(P);
    // ---------- bâtiments annexes dessinés sur leur propre feuille : placés grâce au plan masse
    let annexHints = [];
    try { annexHints = await placeAnnexes(P, pieces, log); } catch (e) { log('Annexes : ' + e.message); }
    P.angs = (reads[0].L.angs || [0]).map(a => +(+a).toFixed(2));
    // ---------- toitures par défaut : une terrasse sur chaque emprise non recouverte
    defaultRoofs(P);
    annexHints.forEach(h => {
      const r = P.roofs.find(r => r.lev === h.lev && inPoly(centroid(r.o), h.o)); if (!r) return;
      if (h.ht != null) r.z = +(P.levels[h.lev].z + h.ht).toFixed(2);
      if (r.type === 'terrasse') { r.type = '2pans'; r.slope = 30; r.axis = 'long'; }
      r.src = 'feuille « ' + h.sheet + ' » et plan masse (pente supposée ' + r.slope + ' %, à vérifier sur les coupes de la feuille)';
    });
    // ---------- escaliers lus sur les plans : ceux d'un étage montent du niveau du dessous (vue de dessus complète)
    buildStairs(P, stairL, log);
    // ---------- préaux et auvents lus sur les plans : poteaux et couverture légère, sous le plancher de l'étage
    canop.forEach((c, k) => {
      const L = P.levels[c.lev], zt = +(L.z + Math.max(2.6, Math.min(L.h - 0.25, 3.6))).toFixed(2);
      c.posts.forEach(p => P.cols.push({ lev: c.lev, c: p, d: c.d, h: +(zt - 0.5 - L.z).toFixed(2), auvent: true }));
      P.roofs.push({ id: 'A' + c.lev + '.' + k, lev: c.lev, o: c.o, type: 'auvent', z: zt, slope: 0, ridge: null, axis: null, bays: c.bays, pv: null,
        src: 'plan : poteaux et surface du « ' + c.n + ' » (' + c.a + ' m²) ; hauteur supposée sous le plancher de l’étage' });
    });
    // ---------- façades : allèges et hauteurs des baies, pignons et pentes, matériaux des murs
    const facs = pieces.filter(p => p.cls.kind === 'facade' && !p.skip);
    if (typeof FAC !== 'undefined' && facs.length) {
      const views = [];
      for (const p of facs) {
        log('Lecture des façades ' + p.file.name + '…');
        for (let i = 1; i <= Math.min(p.doc.numPages, 4); i++) {
          const pg = i === 1 ? p.page : await p.doc.getPage(i), its = i === 1 ? p.items : (await PDFX.pageText(pg)).items;
          try { views.push(...await FAC.read(pg, its, { scale: p.cls.scale || 100 }, log)); } catch (e) { log('  façades illisibles : ' + e.message); }
        }
        P.pieces.find(x => x.nom === p.file.name).used = true;
      }
      P.facData = views.map(FAC.pack);   // gardées pour refaire le report si l'élève corrige une association
      FAC.apply(P, views, log);
    }
    if (P.alt.faitage > P.alt.egout + 0.6 && P.alt.egout > 0) P.notes.push({ k: 'toiture', t: `Toiture en pente détectée sur les coupes (égout +${P.alt.egout.toFixed(2)}, faîtage +${P.alt.faitage.toFixed(2)}) : choisissez « deux pans » sur les blocs concernés dans l'onglet Plans.` });
    // ---------- pièces écrites
    for (const p of pieces.filter(p => p.cls.kind === 'cctp' && !p.skip)) { log('Lecture du CCTP ' + p.file.name + '…'); const c = await ECRITS.readCCTP(p.doc, p.cls, log); if (!c.titre) c.titre = titleFromName(p.file.name); P.cctp.push(c); P.pieces.find(x => x.nom === p.file.name).used = true; }
    for (const p of pieces.filter(p => p.cls.kind === 'dpgf' && !p.skip)) { log('Lecture du DPGF ' + p.file.name + '…'); const d = await ECRITS.readDPGF(p.doc, p.cls, log); P.dpgf.push(d); P.pieces.find(x => x.nom === p.file.name).used = true; }
    P.cctp.sort((a, b) => a.lot.localeCompare(b.lot)); P.dpgf.sort((a, b) => a.lot.localeCompare(b.lot));
    // préau photovoltaïque ? Un article du CCTP titré « préau » (ou un de ses sous-articles) parle de modules photovoltaïques
    if (P.roofs.some(r => r.type === 'auvent')) { const pv = preauPV(P); P.roofs.forEach(r => { if (r.type === 'auvent') r.pv = pv; }); }
    return P;
  }
  // « ECOLE X-CCTP 05-PLATRERIE-FAUX PLAFONDS.pdf » → « Plâtrerie - faux plafonds »
  function titleFromName(f) {
    const m = f.replace(/\.pdf$/i, '').match(/(?:CCTP|DPGF|LOT)\s*N?°?\s*\d{1,2}[A-Z]?\s*[-_ ]+\s*(.{4,})$/i);
    if (!m) return '';
    const t = m[1].replace(/[_]+/g, ' ').replace(/\s*-\s*/g, ' - ').trim().toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function overlapAlign(A, B) {
    const ca = bbox(A.flatMap(f => f.o)), cb = bbox(B.flatMap(f => f.o));
    return { dx: (ca.x0 + ca.x1) / 2 - (cb.x0 + cb.x1) / 2, dy: (ca.y0 + ca.y1) / 2 - (cb.y0 + cb.y1) / 2 };
  }
  // toitures par défaut : la part de chaque emprise que ne couvre aucun niveau supérieur (calcul sur grille de 10 cm)
  function defaultRoofs(P) {
    P.roofs = [];
    const all = P.fp.flatMap(f => f.o); if (!all.length) return;
    const B = bbox(all), k = 10, x0 = B.x0 - 1, y0 = B.y0 - 1, W = Math.ceil((B.x1 - x0 + 1) * k), H = Math.ceil((B.y1 - y0 + 1) * k);
    const px = o => o.map(p => [(p[0] - x0) * k, (p[1] - y0) * k]);
    P.levels.forEach((L, i) => {
      const m = new Uint8Array(W * H), up = new Uint8Array(W * H);
      P.fp.forEach(f => { if (f.lev === i) RS.fillPoly(m, W, H, px(f.o), 1); else if (f.lev > i) RS.fillPoly(up, W, H, px(f.o), 1); });
      const free = RS.open(RS.andNot(m, RS.dilate(up, W, H, 2)), W, H, 4);
      RS.polygons(free, W, H, 1.5, 6 * k * k).forEach((p, j) => {
        const o = p.o.map(q => [+(q[0] / k + x0).toFixed(2), +(q[1] / k + y0).toFixed(2)]);
        P.roofs.push({ id: 'T' + i + '.' + j, lev: i, o, type: 'terrasse', z: +(L.z + L.h).toFixed(2), slope: 30, ridge: null, axis: null, src: L.hsrc || 'hyp' });
      });
    });
  }
  // à l'étage, un bloc sans aucun local est le plus souvent la toiture dessinée d'un bloc plus bas : on l'écarte avec ses murs
  function pruneUpper(P) {
    let n = 0;
    P.levels.forEach((L, i) => {
      if (i === 0) return;
      const R = P.rooms.filter(r => r.lev === i && !r.ext).map(r => centroid(r.polys[0]));
      const keep = P.fp.filter(f => f.lev !== i || R.some(c => inPoly(c, f.o)));
      const gone = P.fp.filter(f => !keep.includes(f));
      const kept = keep.filter(f => f.lev === i); if (!kept.length) return;
      const inside = p => kept.some(f => inPoly(p, f.o) || distPoly(p, f.o) < 0.6);
      P.fp = keep;
      const w0 = P.walls.length;
      P.walls = P.walls.filter(w => w.lev !== i || inside(centroid(w.o)));
      n += gone.length + (P.walls.length < w0 ? 1 : 0);
      P.open = P.open.filter(o => o.lev !== i || inside(o.c));
      P.cols = P.cols.filter(o => o.lev !== i || inside(o.c));
    });
    if (n) P.notes.push({ k: 'emprise', t: 'Aux étages, les traits hors de l’emprise des locaux ont été écartés (toiture dessinée d’un bâtiment plus bas, brise-soleil, auvents) : vérifiez-les sur les plans du DCE.' });
    return n;
  }
  function buildStairs(P, SL, log) {
    const cen = q => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
    const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    SL.filter(s => s.lev >= 1 && P.levels[s.lev] && P.levels[s.lev - 1]).forEach(s => {
      let how = 'flèche de montée du plan';
      if (s.guess) {
        // sans flèche : la partie de l'escalier vue au plan du dessous est son départ
        const below = SL.filter(b => b.lev === s.lev - 1).flatMap(b => b.runs);
        s.runs.forEach(r => { const hit = below.find(b => s.runs.length === 1 && Math.abs((b.q[1][0] - b.q[0][0]) * (r.q[1][0] - r.q[0][0]) + (b.q[1][1] - b.q[0][1]) * (r.q[1][1] - r.q[0][1])) > 0.8 * Math.hypot(b.q[1][0] - b.q[0][0], b.q[1][1] - b.q[0][1]) * Math.hypot(r.q[1][0] - r.q[0][0], r.q[1][1] - r.q[0][1]) && inPoly(cen(b.q), r.q.map((p, k) => p)) );
          if (hit) { const c = cen(hit.q), e0 = [(r.q[0][0] + r.q[1][0]) / 2, (r.q[0][1] + r.q[1][1]) / 2], e1 = [(r.q[2][0] + r.q[3][0]) / 2, (r.q[2][1] + r.q[3][1]) / 2]; r.up = d2(c, e0) < d2(c, e1) ? 1 : -1; how = 'départ vu au plan du niveau inférieur'; s.guess = false; } });
        if (s.guess) how = 'sens de montée supposé (pas de flèche sur le plan)';
      }
      const z0 = P.levels[s.lev - 1].z, z1 = P.levels[s.lev].z, H = z1 - z0, tot = s.runs.reduce((a, r) => a + r.nt, 0) || 1;
      let z = z0; const parts = [];
      s.runs.forEach((r, k) => {
        const dz = H * r.nt / tot, q = r.up > 0 ? r.q : [r.q[2], r.q[3], r.q[0], r.q[1]];
        parts.push({ k: 'vol', q, z0: +z.toFixed(3), z1: +(z + dz).toFixed(3), dir: [2, 3], n: r.nt, w: r.w, g: r.g }); z += dz;
        if (k < s.lands.length) parts.push({ k: 'pal', q: s.lands[k], z: +z.toFixed(3) });
      });
      const c = cen(s.runs[0].q), ext = !P.fp.some(f => f.lev === s.lev - 1 && inPoly(c, f.o));
      const nm = s.runs.map(r => r.nt).join(' + ');
      P.stairs.push({ n: (ext ? 'Escalier extérieur ' : 'Escalier ') + (P.stairs.length + 1), lev: s.lev - 1, ext, parts, src: 'plan ' + P.levels[s.lev].nom + ' : ' + nm + ' marches, giron ' + Math.round(s.runs[0].g * 100) + ' cm, emmarchement ' + s.runs[0].w.toFixed(2).replace('.', ',') + ' m ; ' + how });
      log('Escalier ' + (ext ? 'extérieur ' : '') + P.levels[s.lev - 1].nom + ' → ' + P.levels[s.lev].nom + ' : ' + nm + ' marches (' + how + ')');
    });
  }
  function preauPV(P) {
    let pv = false;
    (P.cctp || []).forEach(c => { const A = c.articles || []; A.filter(a => /PR[EÉ]AU|AUVENT/i.test(a.titre || '')).forEach(h => { const pre = h.num + '.'; if (A.some(a => (a.num === h.num || String(a.num || '').startsWith(pre)) && /photovolta/i.test((a.titre || '') + ' ' + (a.texte || '')))) pv = true; }); });
    return pv;
  }
  // ---------- annexes : plan masse calé sur le RDC par les étiquettes de locaux communes, puis contour de chaque annexe
  const N_ = s => PDFX.norm(s).replace(/[^A-Z0-9]/g, '');
  function fitSim(pairs) {   // similitude (rotation, échelle, translation) des points s vers d, moindres carrés
    const n = pairs.length; let sx = 0, sy = 0, dx = 0, dy = 0; pairs.forEach(p => { sx += p.s[0]; sy += p.s[1]; dx += p.d[0]; dy += p.d[1]; }); sx /= n; sy /= n; dx /= n; dy /= n;
    let a = 0, b = 0, q = 0; pairs.forEach(p => { const x = p.s[0] - sx, y = p.s[1] - sy, u = p.d[0] - dx, v = p.d[1] - dy; a += x * u + y * v; b += x * v - y * u; q += x * x + y * y; });
    const th = Math.atan2(b, a), k = Math.hypot(a, b) / (q || 1), c = Math.cos(th) * k, s = Math.sin(th) * k;
    return { c, s, k, th, tx: dx - (c * sx - s * sy), ty: dy - (s * sx + c * sy) };
  }
  const simAp = (T, p) => [T.c * p[0] - T.s * p[1] + T.tx, T.s * p[0] + T.c * p[1] + T.ty];
  const med_ = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
  async function placeAnnexes(P, pieces, log) {
    const out = [], lev0 = P.levels.findIndex(L => L.n === 0); if (lev0 < 0) return out;
    const sheets = pieces.filter(p => !p.skip && p.items && ['annexe', 'coupe', 'facade', 'plan'].includes(p.cls.kind) && /LOCAL|SALLE|ANNEXE|PREAU|ABRI|RANGEMENT|GARAGE|ATELIER|LOGE|GYMNASE/.test(PDFX.norm(p.file.name)) && !/PRINCIPAL|ASSEMBLAGE|ZONE|NIVEAU/.test(PDFX.norm(p.file.name)));
    const want = []; sheets.forEach(sh => PLAN.labels(sh.items).filter(r => r.a && !r.noname && !r.ext).forEach(r => want.push({ n: r.n, a: r.a, sheet: sh })));
    if (!want.length) return out;
    const R0 = P.rooms.filter(r => r.lev === lev0 && r.l && !r.noname), cnt = new Map(); R0.forEach(r => { const k = N_(r.n); cnt.set(k, (cnt.get(k) || 0) + 1); });
    let best = null;
    pieces.filter(p => p.cls.kind === 'masse' && p.items && p.page).forEach(sp => {
      const ppm = 72 / 0.0254 / (sp.cls.scale || 200), its = sp.items.filter(t => Math.abs(t.ang) < 0.3 && /[A-Za-z]{2,}/.test(t.s)), sc = new Map();
      its.forEach(t => { const k = N_(t.s); sc.set(k, (sc.get(k) || 0) + 1); });
      let pairs = []; its.forEach(t => { const k = N_(t.s); if (k.length < 3 || sc.get(k) !== 1 || cnt.get(k) !== 1) return; pairs.push({ s: [t.cx / ppm, t.cy / ppm], d: R0.find(r => N_(r.n) === k).l }); });
      let T = pairs.length >= 4 ? fitSim(pairs) : null;
      for (let it = 0; it < 5 && T; it++) { const res = pairs.map(p => Math.hypot(...simAp(T, p.s).map((v, j) => v - p.d[j]))), m = med_(res), keep = pairs.filter((p, i) => res[i] <= Math.max(1.0, 2.5 * m)); if (keep.length === pairs.length) break; if (keep.length < 4) { T = null; break; } pairs = keep; T = fitSim(pairs); }
      if (!T) return;
      const m = med_(pairs.map(p => Math.hypot(...simAp(T, p.s).map((v, j) => v - p.d[j]))));
      if (m > 1.0 || Math.abs(T.k - 1) > 0.06) return;
      if (!best || pairs.length > best.n) best = { sp, T, ppm, n: pairs.length, m, its };
    });
    if (!best) { log('Annexes : aucun plan masse ne porte assez d’étiquettes communes avec le rez-de-chaussée pour les placer.'); return out; }
    log(`Plan masse « ${best.sp.file.name} » calé sur le rez-de-chaussée par ${best.n} étiquettes de locaux communes (écart médian ${best.m.toFixed(2)} m).`);
    const wt = (() => { const c = new Map(); P.walls.filter(w => w.lev === lev0 && w.ext && w.t).forEach(w => c.set(w.t, (c.get(w.t) || 0) + 1)); return [...c].sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || null; })();
    for (const w of want) {
      const k = N_(w.n), t = best.its.find(t => N_(t.s) === k) || best.its.find(t => N_(t.s).length > 5 && (N_(t.s).includes(k) || k.includes(N_(t.s))));
      if (!t) { log('  ' + w.n + ' (feuille « ' + w.sheet.file.name + ' ») : absent du plan masse, non placé'); continue; }
      const c = simAp(best.T, [t.cx / best.ppm, t.cy / best.ppm]);
      const hit = P.fp.find(f => f.lev === lev0 && inPoly(c, f.o));
      if (hit) { if (Math.abs(area2(hit.o)) < 400) { out.push({ lev: lev0, o: hit.o, sheet: w.sheet.file.name }); log('  ' + w.n + ' : déjà dessiné au plan du rez-de-chaussée (toiture d’après sa feuille)'); } continue; }
      if (P.rooms.some(r => r.lev === lev0 && r.polys.some(o => inPoly(c, o)))) continue;
      const box = interior(best, t, w.a);
      if (!box) { log('  ' + w.n + ' : étiquette trouvée sur le plan masse, mais pas son contour'); continue; }
      const th = 0.22, M = q => simAp(best.T, q);
      const inner = box.map(M), mid = grow(box, th / 2).map(M), outer = grow(box, th).map(M);
      const am = Math.abs(area2(inner));
      P.rooms.push({ id: 'R0.A' + String(P.rooms.length + 1).padStart(3, '0'), lev: lev0, n: w.n, a: w.a, am: +am.toFixed(2), hs: null, ext: false, noname: false, l: c, annexe: w.sheet.file.name,
        fid: Math.abs(am / w.a - 1) <= 0.15 ? 'bon' : Math.abs(am / w.a - 1) <= 0.3 ? 'moyen' : 'faible', polys: [inner] });
      for (let i = 0; i < 4; i++) {   // murs dans l'axe, prolongés d'une demi-épaisseur pour fermer les angles
        const p = mid[i], q = mid[(i + 1) % 4], L = Math.hypot(q[0] - p[0], q[1] - p[1]), e = [(q[0] - p[0]) / L * th / 2, (q[1] - p[1]) / L * th / 2];
        P.walls.push({ lev: lev0, t: wt, o: [outer[i], outer[(i + 1) % 4], inner[(i + 1) % 4], inner[i]], h: [], a: [p[0] - e[0], p[1] - e[1]], b: [q[0] + e[0], q[1] + e[1]], th, ext: true, ht: 2.8, annexe: true });
      }
      P.fp.push({ lev: lev0, o: outer, area: +Math.abs(area2(outer)).toFixed(2), annexe: true });
      out.push({ lev: lev0, o: outer, ht: 2.8, sheet: w.sheet.file.name });
      log('  ' + w.n + ' (' + w.a + ' m²) placé d’après le plan masse : ' + am.toFixed(1) + ' m² relevés, hauteur supposée 2,80 m');
    }
    return out;
  }
  // rectangle (repère du plan masse, mètres) qui entoure l'étiquette : rendu de la feuille, remplissage du blanc intérieur, axes principaux
  function interior(best, t, A) {
    const ppm = best.ppm, hs = Math.max(4, 1.6 * Math.sqrt(A)), res = 20, W = Math.round(2 * hs * res), x0 = t.cx - hs * ppm, y0 = t.cy - hs * ppm;
    const px = best.sp.page.view(x0, y0, 2 * hs * ppm, 2 * hs * ppm, W, W), white = new Uint8Array(W * W);
    for (let i = 0; i < W * W; i++) { const r = px[4 * i], g = px[4 * i + 1], b = px[4 * i + 2]; white[i] = r > 236 && g > 236 && b > 236 ? 1 : 0; }
    const toPx = (x, y) => [Math.round((x - x0) / ppm * res), Math.round((y - y0) / ppm * res)];
    const seeds = [toPx(t.cx, t.y0 - 0.45 * ppm), toPx(t.cx, t.y1 + 0.45 * ppm), toPx(t.x0 - 0.4 * ppm, t.cy), toPx(t.x1 + 0.4 * ppm, t.cy), toPx(t.cx, t.y1 + 1.4 * ppm)];
    let bestR = null;
    seeds.forEach(([sx, sy]) => {
      if (sx < 1 || sy < 1 || sx >= W - 1 || sy >= W - 1 || !white[sy * W + sx]) return;
      const seen = new Uint8Array(W * W), st = [sy * W + sx]; seen[st[0]] = 1; const pts = []; let edge = false;
      while (st.length) { const i = st.pop(), x = i % W, y = (i - x) / W; pts.push(x, y); if (x === 0 || y === 0 || x === W - 1 || y === W - 1) { edge = true; break; }
        [i - 1, i + 1, i - W, i + W].forEach(j => { if (!seen[j] && white[j]) { seen[j] = 1; st.push(j); } }); }
      if (edge) return;
      const n = pts.length / 2, am = n / res / res; if (am < 0.5 * A || am > 1.6 * A) return;
      if (!bestR || n > bestR.n) bestR = { n, pts };
    });
    if (!bestR) return null;
    const p = bestR.pts, n = bestR.n; let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += p[2 * i]; my += p[2 * i + 1]; } mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0; for (let i = 0; i < n; i++) { const x = p[2 * i] - mx, y = p[2 * i + 1] - my; sxx += x * x; syy += y * y; sxy += x * y; }
    const a = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(a), uy = Math.sin(a);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9; for (let i = 0; i < n; i++) { const x = p[2 * i] - mx, y = p[2 * i + 1] - my, u = x * ux + y * uy, v = -x * uy + y * ux; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    u0 -= 0.5; u1 += 0.5; v0 -= 0.5; v1 += 0.5;    // bords des pixels
    if ((u1 - u0) * (v1 - v0) / res / res > 1.5 * A) return null;
    const Q = (u, v) => { const X = mx + u * ux - v * uy, Y = my + u * uy + v * ux; return [(x0 + X / res * ppm) / ppm, (y0 + Y / res * ppm) / ppm]; };
    return [Q(u0, v0), Q(u1, v0), Q(u1, v1), Q(u0, v1)];
  }
  function grow(o, d) {   // rectangle agrandi de d sur chaque côté
    const c = [(o[0][0] + o[2][0]) / 2, (o[0][1] + o[2][1]) / 2], ux = [o[1][0] - o[0][0], o[1][1] - o[0][1]], vx = [o[3][0] - o[0][0], o[3][1] - o[0][1]], lu = Math.hypot(...ux), lv = Math.hypot(...vx);
    const eu = [ux[0] / lu, ux[1] / lu], ev = [vx[0] / lv, vx[1] / lv], hu = lu / 2 + d, hv = lv / 2 + d;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [c[0] + eu[0] * hu * a + ev[0] * hv * b, c[1] + eu[1] * hu * a + ev[1] * hv * b]);
  }
  // coupe une zone de toiture en deux par la droite (a, b) ; renvoie le nombre de morceaux créés
  function splitRoof(P, idx, a, b) {
    const r = P.roofs[idx]; if (!r) return 0;
    const B = bbox(r.o), k = 10, x0 = B.x0 - 1, y0 = B.y0 - 1, W = Math.ceil((B.x1 - x0 + 1) * k), H = Math.ceil((B.y1 - y0 + 1) * k);
    const m = new Uint8Array(W * H); RS.fillPoly(m, W, H, r.o.map(p => [(p[0] - x0) * k, (p[1] - y0) * k]), 1);
    const A = new Uint8Array(W * H), C = new Uint8Array(W * H), dx = b[0] - a[0], dy = b[1] - a[1];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!m[i]) continue; const px = x / k + x0 - a[0], py = y / k + y0 - a[1]; const s = dx * py - dy * px; if (s > 0.06) A[i] = 1; else if (s < -0.06) C[i] = 1; }
    const parts = [A, C].flatMap(M => RS.polygons(M, W, H, 1.2, 2 * k * k)).map(p => p.o.map(q => [+(q[0] / k + x0).toFixed(2), +(q[1] / k + y0).toFixed(2)]));
    if (parts.length < 2) return 0;
    P.roofs.splice(idx, 1, ...parts.map((o, j) => Object.assign({}, r, { id: r.id + String.fromCharCode(97 + j), o })));
    return parts.length;
  }
  const centroid = r => { let x = 0, y = 0; r.forEach(p => { x += p[0]; y += p[1]; }); return [x / r.length, y / r.length]; };
  const inPoly = (pt, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if (((a[1] > pt[1]) !== (b[1] > pt[1])) && (pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0])) c = !c; } return c; };

  // ------------------------------------------------------------------ liens CCTP ↔ locaux, DPGF ↔ CCTP
  const ABBR = [[/\bSANITAIRES?\b/g, 'SANIT'], [/\bRANGEMENTS?\b/g, 'RGT'], [/\bDEGAGEMENTS?\b/g, 'DEGT'], [/\bVESTIAIRES?\b/g, 'VEST'], [/\bCIRCULATIONS?\b/g, 'CIRCULATION'], [/\bBUREAUX?\b/g, 'B'], [/\bLOCAUX\b|\bLOCAL\b/g, 'LOC'], [/\bCONTENEURS?\b|\bCONTAINERS?\b/g, 'CONT'], [/\bENTRETIEN\b/g, 'ENTRETIEN'], [/\bPRODUITS?\b/g, 'PROD'], [/\bVAISSELLE\b/g, 'VAISS'], [/\bMENAGE\b/g, 'MENAG'], [/\bENCAISSEMENT\b/g, 'ENCAIS']];
  function canon(s) {
    let u = ' ' + norm(s).replace(/[.,;:()\/\-–'’«»"]/g, ' ').replace(/\s+/g, ' ') + ' ';
    ABBR.forEach(([re, r]) => { u = u.replace(re, r); });
    return u.replace(/\b(LE|LA|LES|DE|DU|DES|ET|EN|A|AU|AUX|L|D)\b/g, ' ').replace(/\s+/g, ' ');
  }
  function link(P) {
    // tokens de chaque local
    const R = P.rooms.filter(r => !r.noname).map(r => { const c = canon(r.n).trim(); return { r, c, re: new RegExp('\\b' + c.split(' ').map(w => w.length <= 2 ? w + '\\b' : w.replace(/[A-Z]$/, '') + '\\w*').join('\\s*') ) }; });
    P.cctp.forEach(lot => lot.articles.forEach(a => {
      a.rooms = [];
      if (!a.loc) return;
      const L = canon(a.loc);
      R.forEach(x => { if (x.c.length >= 3 && x.re.test(L)) a.rooms.push(x.r.id); });
      // « tous locaux » seulement si la localisation ne détaille pas ensuite une liste de locaux reconnus
      a.tous = /TOUS (LES )?LOCAUX|ENSEMBLE DE L.?OPERATION|TOUT LE BATIMENT/.test(norm(a.loc)) && a.rooms.length < 3;
    }));
    // DPGF ↔ CCTP par lot et numéro
    P.dpgf.forEach(d => {
      const lot = P.cctp.find(c => c.lot === d.lot);
      d.lignes.forEach(l => {
        l.art = null;
        if (lot && l.num) { const a = lot.articles.find(a => a.num === l.num) || lot.articles.find(a => a.num === l.num.replace(/\.0$/, '')); if (a) l.art = a.num; }
        if (lot && !l.art && l.des) { const k = canon(l.des).trim().split(' ').filter(w => w.length > 3).slice(0, 4); const a = lot.articles.find(a => k.length >= 2 && k.every(w => canon(a.titre).includes(w))); if (a) { l.art = a.num; l.artApprox = true; } }
      });
    });
  }

  // ------------------------------------------------------------------ métré de la maquette (règles lisibles)
  function wallLen(w) { const A = Math.abs(area2(w.o)) - (w.h || []).reduce((s, h) => s + Math.abs(area2(h)), 0), Pm = perim(w.o); const e = (Pm - Math.sqrt(Math.max(0, Pm * Pm - 16 * A))) / 4; return { A, e, L: e > 0 ? A / e : 0 }; }
  function quantities(P) {
    const Q = {};
    const lev = i => P.levels[i];
    const hsp = r => (r.hs ? r.hs[1] : 2.5);
    const roomA = r => r.a || r.am;
    const roomPer = r => r.polys.reduce((s, p) => s + perim(p), 0);
    Q.roomA = roomA; Q.roomPer = roomPer; Q.hsp = hsp;
    Q.wallsBy = {};
    // longueurs de murs par type de la légende (murs « métier » : longueur exacte de l'axe)
    Q.byType = {}; P.walls.forEach(w => { const L = w.a && w.b ? Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) : wallLen(w).L; Q.byType[w.t] = (Q.byType[w.t] || 0) + L; });
    const hsAll = P.rooms.filter(r => r.hs && !r.ext).map(r => r.hs[1]).sort((x, y) => x - y); Q.hsp = hsAll.length ? hsAll[hsAll.length >> 1] : 2.6;
    P.walls.forEach(w => { const k = (P.wtypes[w.t] || {}).kind || 'autre', d = wallLen(w), H = lev(w.lev) ? lev(w.lev).h : 3; Q.wallsBy[k] = Q.wallsBy[k] || { L: 0, S: 0, emprise: 0 }; Q.wallsBy[k].L += d.L; Q.wallsBy[k].S += d.L * H; Q.wallsBy[k].emprise += d.A; });
    Q.fpArea = P.fp.filter(f => f.lev === 0).reduce((s, f) => s + Math.abs(area2(f.o)), 0);
    Q.slabArea = P.fp.filter(f => f.lev > 0).reduce((s, f) => s + Math.abs(area2(f.o)), 0);
    Q.roofFlat = P.roofs.filter(r => r.type === 'terrasse').reduce((s, r) => s + Math.abs(area2(r.o)), 0);
    Q.roofPitch = P.roofs.filter(r => r.type !== 'terrasse').reduce((s, r) => s + Math.abs(area2(r.o)) * Math.sqrt(1 + (r.slope / 100) ** 2), 0);
    Q.extOpen = P.open.filter(o => o.ext); Q.intOpen = P.open.filter(o => !o.ext);
    return Q;
  }
  // estimation d'une ligne de DPGF à partir de la maquette : {q, how, rooms[]}
  function estimate(P, Q, line, art, lotT) {
    if (!line.num && !art) return null;                  // sous-détail sans numéro (béton, coffrage, acier…) : pas de comparaison
    const d = canon(line.des + ' ' + (art ? art.titre : '')), u = (line.u || '').toLowerCase();
    // chaque règle ne vaut que pour le corps d'état concerné (l'« étanchéité » du gros-œuvre n'est pas la toiture)
    const lt = canon(lotT || ''), dom = re => !lt.trim() || re.test(lt);
    const GO = /GROS|FONDATION|BETON|MACONN|GO\b/, COUV = /COUV|ETANCH|TOIT|ENVELOPPE|ZINC|CHARPENTE/, PLAT = /PLATR|CLOISON|PLAFOND|DOUBLAGE/, SOL = /SOL|CARREL|FAIENCE|REVET/, PEINT = /PEINT|REVET/, MEN = /MENUIS|PORTE|SERRUR/, BOIS = /BOIS|OSSATURE|STRUCTURE/;
    const roomsOf = () => {
      if (art && art.rooms && art.rooms.length) return P.rooms.filter(r => art.rooms.includes(r.id));
      if (art && art.tous) return P.rooms.filter(r => !r.ext);
      return null;
    };
    const RR = roomsOf();
    const sumA = L => L.reduce((s, r) => s + Q.roomA(r), 0), sumP = L => L.reduce((s, r) => s + Q.roomPer(r), 0);
    const doorsIn = L => P.open.filter(o => !o.ext && L.some(r => r.lev === o.lev && r.polys.some(p => distPoly(o.c, p) < 0.6))).reduce((s, o) => s + o.w, 0);
    const res = (q, how, rooms) => ({ q: +q.toFixed(2), how, rooms: (rooms || []).map(r => r.id) });
    if (/^m[²2]$/.test(u)) {
      if (/FAIENCE|REVETEMENTS? MURA|MURAUX/.test(d) && RR && dom(SOL)) { const h = art && /2[.,]10/.test(art.texte || '') ? 2.1 : 2.1; return res(Math.max(0, sumP(RR) - doorsIn(RR)) * h, `périmètre des locaux de la localisation (${RR.length}) moins les portes, × ${h} m de hauteur`, RR); }
      if (/(SOL|CHAPE|RAGREAGE|REVETEMENT|CARRELAGE|PVC|TEXTILE|INSONORISATION|PARQUET|RESINE|SOUS COUCHE|SPEC|SEL\b|ETANCHEITE LIQUIDE|BARRIERE)/.test(d) && RR && dom(SOL)) return res(sumA(RR), `somme des surfaces des locaux cités dans la localisation du CCTP (${RR.length} locaux)`, RR);
      // cloisons : le type se reconnaît à son épaisseur (« 100/70 » ≈ cloison de 98 mm de la légende)
      if (/CLOISON|DOUBLAGE|CONTRE CLOISON/.test(d) && dom(PLAT) && !/PLUE|PLUS.?VALUE|PARE?MENT|JOUE/.test(d)) {
        const m = (line.des + ' ' + (art ? art.titre : '')).match(/(\d{2,3})\s*\/\s*\d{2,3}/), e = m ? +m[1] : null;
        if (e) { const T = Object.entries(P.wtypes).filter(([k, t]) => /cloi|doub/.test(t.kind) && Math.abs(((String(t.nom).match(/(\d{2,3})\s*mm/) || [])[1] || 0) - e) <= 6);
          const L = T.reduce((s2, [k]) => s2 + (Q.byType[k] || 0), 0);
          if (L > 0) return res(L * Q.hsp, `longueur des cloisons « ${T.map(([, t]) => t.nom).join(', ')} » relevées (${fmtN(L)} m) × hauteur sous plafond médiane (${fmtN(Q.hsp)} m), baies non déduites`); }
      }
      if (/PLAFOND/.test(d) && RR && dom(PLAT)) return res(sumA(RR), `somme des surfaces des locaux de la localisation (${RR.length})`, RR);
      if (/DALLAGE/.test(d) && dom(GO)) return res(Q.fpArea, 'emprise du rez-de-chaussée');
      if (/PLANCHER|PREDALLE|DALLE PLEINE/.test(d) && dom(GO) && Q.slabArea) return res(Q.slabArea, 'surface des planchers d’étage (emprises des niveaux supérieurs)');
      if (/COUVERTURE|ZINC|TUILE|BAC ACIER/.test(d) && Q.roofPitch && dom(COUV)) return res(Q.roofPitch, 'surface des toitures en pente (rampant)');
      if (/ETANCHEITE|TOITURE TERRASSE/.test(d) && Q.roofFlat && dom(COUV)) return res(Q.roofFlat, 'surface des toitures-terrasses');
      if (/PEINTURE/.test(d) && /MUR|PAROI/.test(d) && dom(PEINT)) { const L = RR || P.rooms.filter(r => !r.ext); return res(L.reduce((s, r) => s + Q.roomPer(r) * Q.hsp(r), 0) * 0.85, 'périmètre × hauteur sous plafond des locaux, moins 15 % d’ouvertures', L); }
    }
    if (/^ml$|^m$/.test(u)) {
      if (/PLINTHE/.test(d) && RR && dom(SOL)) return res(Math.max(0, sumP(RR) - doorsIn(RR)), `périmètre des locaux de la localisation moins les portes (${RR.length})`, RR);
      if (/GARDE CORPS|MAIN COURANTE/.test(d)) return null;
    }
    if (/^u$/.test(u)) {
    }
    return null;
  }
  function distPoly(p, P) { let best = 1e9; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t)); best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)); } return best; }

  // ------------------------------------------------------------------ incohérences → questions au maître d'œuvre
  function issues(P, Q) {
    const out = [];
    const lotName = n => { const c = P.cctp.find(x => x.lot === n), d = P.dpgf.find(x => x.lot === n); return 'Lot ' + n + ((c && c.titre) || (d && d.titre) ? ' (' + ((c && c.titre) || d.titre) + ')' : ''); };
    P.dpgf.forEach(d => {
      const lot = P.cctp.find(c => c.lot === d.lot);
      if (!lot) out.push({ niv: 'info', lot: d.lot, t: `${lotName(d.lot)} : DPGF fourni sans CCTP dans le dossier déposé.`, q: `Le CCTP du lot ${d.lot} est-il disponible ? Sans lui, les prestations du DPGF ne sont pas définies.` });
      const sansArt = [];
      d.lignes.forEach(l => {
        if (l.num && l.u && l.u !== 'ens' && l.u !== 'ft' && (l.q === null || l.q === undefined)) out.push({ niv: 'q', lot: d.lot, art: l.num, t: `${lotName(d.lot)}, art. ${l.num} « ${l.des.slice(0, 70)} » : unité « ${l.u} » sans quantité.`, q: `Quelle quantité faut-il chiffrer pour l'article ${l.num} « ${l.des.slice(0, 60)} » ?` });
        if (lot && l.num && !l.art && /\./.test(l.num)) sansArt.push(l);
        if (l.q && l.est && l.est.q > 0) {
          const e = l.q / l.est.q - 1;
          if (Math.abs(e) > 0.85) out.push({ niv: 'info', lot: d.lot, art: l.num, t: `${lotName(d.lot)}, art. ${l.num} : DPGF ${fmtN(l.q)} ${l.u}, maquette ${fmtN(l.est.q)} ${l.u}. Écart trop fort pour conclure : la règle de mesure (${l.est.how}) ne correspond sans doute pas à cette ligne.`, q: `Quel est le périmètre exact de l'article ${l.num} « ${l.des.slice(0, 60)} » (${fmtN(l.q)} ${l.u}) ?` });
          else if (Math.abs(e) > 0.25) out.push({ niv: 'ecart', lot: d.lot, art: l.num, t: `${lotName(d.lot)}, art. ${l.num} : DPGF ${fmtN(l.q)} ${l.u}, maquette ${fmtN(l.est.q)} ${l.u} (${e > 0 ? '+' : ''}${Math.round(e * 100)} %).`, q: `La quantité de l'article ${l.num} (${fmtN(l.q)} ${l.u}) diffère de notre métré (${fmtN(l.est.q)} ${l.u}). Pouvez-vous confirmer le périmètre de la prestation ?` });
        }
      });
      if (sansArt.length) out.push({ niv: 'q', lot: d.lot, art: sansArt.length === 1 ? sansArt[0].num : '', t: `${lotName(d.lot)} : ${sansArt.length} ligne(s) du DPGF sans article de même numéro au CCTP (${sansArt.slice(0, 6).map(l => l.num).join(', ')}${sansArt.length > 6 ? '…' : ''}).`, q: `Où sont décrites les prestations ${sansArt.slice(0, 4).map(l => l.num + ' « ' + l.des.slice(0, 40) + ' »').join(', ')}${sansArt.length > 4 ? '…' : ''} ?` });
      // articles d'ouvrage du CCTP sans ligne au DPGF : regroupés par lot
      if (lot) {
        const miss = lot.articles.filter(a => a.feuille && a.niveau >= 2 && /^[3-9]/.test(a.num) && !d.lignes.some(l => l.art === a.num || (l.num && (l.num.startsWith(a.num + '.') || a.num.startsWith(l.num + '.')))));
        if (miss.length) out.push({ niv: 'info', lot: d.lot, art: '', t: `${lotName(d.lot)} : ${miss.length} article(s) d'ouvrage du CCTP sans ligne au DPGF (${miss.slice(0, 8).map(a => a.num).join(', ')}${miss.length > 8 ? '…' : ''}). Vérifiez s'ils sont compris dans une autre ligne ou oubliés.`, q: `Les articles ${miss.slice(0, 5).map(a => a.num + ' « ' + a.titre.slice(0, 35) + ' »').join(', ')}${miss.length > 5 ? '…' : ''} n'ont pas de ligne au DPGF : sont-ils à inclure dans le prix global ?` });
      }
    });
    // locaux cités au CCTP mais introuvables sur les plans
    P.cctp.forEach(lot => lot.articles.forEach(a => {
      if (!a.loc || a.tous) return;
      const words = a.loc.split(/[-–,;\/]|\bet\b/).map(s => s.trim()).filter(s => s.length > 3 && /[A-Za-z]/.test(s) && s.length < 40);
      const miss = words.filter(w => !P.rooms.some(r => { const c = canon(r.n).trim(); return c.length > 2 && canon(w).includes(c); }) && /SANIT|BUREAU|SALLE|LOCAL|CLASSE|VEST|DEGT|DEGAGEMENT|OFFICE|HALL|CIRCUL/.test(norm(w)));
      if (miss.length && miss.length <= 4 && out.filter(o => o.kind === 'loc').length < 12) out.push({ kind: 'loc', niv: 'info', lot: lot.lot, art: a.num, t: `${lotName(lot.lot)}, art. ${a.num} : localisation « ${miss.join(', ')} » sans local de ce nom sur les plans.`, q: `Dans l'article ${a.num}, à quels locaux du plan correspond « ${miss[0]} » ?` });
    }));
    // revêtement de sol : locaux sans article de sol
    const solArts = P.cctp.flatMap(l => l.articles.filter(a => /REVETEMENT.*SOL|SOL.*(SOUPLE|DUR|PVC|TEXTILE|CARREL)|CARRELAGE|PARQUET|RESINE|SOLS? SOUPLES?/.test(norm(a.titre)) && (a.rooms.length || a.tous)));
    if (solArts.length) {
      const covered = new Set(solArts.flatMap(a => a.tous ? P.rooms.filter(r => !r.ext).map(r => r.id) : a.rooms));
      const miss = P.rooms.filter(r => !r.ext && !r.noname && !covered.has(r.id));
      if (miss.length && miss.length < 25) out.push({ niv: 'q', lot: '—', t: `${miss.length} locaux sans revêtement de sol rattaché par le CCTP : ${miss.slice(0, 10).map(r => r.n).join(', ')}${miss.length > 10 ? '…' : ''}.`, q: `Quel revêtement de sol est prévu dans : ${miss.slice(0, 6).map(r => r.n).join(', ')} ?` });
    }
    // menuiseries : repères du plan
    const refs = [...new Set(P.open.filter(o => o.ref).map(o => o.ref))];
    if (refs.length) {
      const mx = P.open.filter(o => o.ref && o.wref && Math.abs(o.wref - o.w) > 0.3);
      if (false) mx.slice(0, 8).forEach(o => out.push({ niv: 'info', lot: '—', t: `Repère ${o.ref} : cote ${fmtN(o.wref)} m sur le plan, ouverture relevée ${fmtN(o.w)} m.`, q: `Quelle est la largeur de la menuiserie ${o.ref} : ${fmtN(o.wref)} m (cote) ou ${fmtN(o.w)} m (dessin) ?` }));
    }
    return out;
  }
  const fmtN = v => Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 2 });

  // ---------- v3 : la maquette est l'IFC du projet ; les PDF donnent les pièces écrites (les plans PDF sont montrés tels quels)
  async function assembleIfc(M, ifcFile, pieces, log = () => {}) {
    const P = { version: 3, source: 'ifc', nom: '', date: new Date().toISOString().slice(0, 10), pieces: [], levels: [], rooms: [], walls: [], open: [], cols: [], fp: [], wtypes: {}, roofs: [], stairs: [], cctp: [], dpgf: [], alt: null, notes: [] };
    P.pieces = [{ nom: ifcFile.name, kind: 'ifc', lot: null, level: null, scale: null, pages: null, partial: false, used: true, size: ifcFile.size }].concat(
      pieces.map(p => ({ nom: p.file.name, kind: p.cls.kind, lot: p.cls.lot || null, level: p.cls.level ? p.cls.level.name : null, scale: p.cls.scale, pages: p.doc.numPages, partial: !!p.cls.partial, used: false })));
    // nom du projet : texte le plus gros récurrent des cartouches, sinon le nom du fichier IFC
    const big = pieces.filter(p => p.items).flatMap(p => p.items.filter(t => /[A-Z]{4,}.*[A-Z]{3,}/.test(t.s) && t.s.length > 12 && t.s.length < 60)).sort((a, b) => b.size - a.size);
    const cnt = new Map(); big.slice(0, 120).forEach(t => cnt.set(t.s.trim(), (cnt.get(t.s.trim()) || 0) + 1));
    P.nom = ([...cnt].sort((a, b) => b[1] - a[1])[0] || [ifcFile.name.replace(/\.ifc$/i, '')])[0];
    IFCX.project(M, P);
    for (const p of pieces.filter(p => p.cls.kind === 'cctp' && !p.skip)) { log('Lecture du CCTP ' + p.file.name + '…'); const c = await ECRITS.readCCTP(p.doc, p.cls, log); if (!c.titre) c.titre = titleFromName(p.file.name); P.cctp.push(c); P.pieces.find(x => x.nom === p.file.name).used = true; }
    for (const p of pieces.filter(p => p.cls.kind === 'dpgf' && !p.skip)) { log('Lecture du DPGF ' + p.file.name + '…'); const d = await ECRITS.readDPGF(p.doc, p.cls, log); P.dpgf.push(d); P.pieces.find(x => x.nom === p.file.name).used = true; }
    P.cctp.sort((a, b) => a.lot.localeCompare(b.lot)); P.dpgf.sort((a, b) => a.lot.localeCompare(b.lot));
    log('Associations des familles de la maquette aux ouvrages du CCTP…');
    IFCX.autoAssoc(P);
    const AS = Object.values(P.assoc), ok = AS.filter(a => a.arts.length).length;
    log(`  ${ok} familles associées d’office sur ${AS.filter(a => !a.sans).length} (à vérifier dans l’onglet Associations)`);
    return P;
  }
  // quantité « maquette » d'une ligne de CDPGF : somme des familles associées, dans l'unité de la ligne
  function ifcEstimate(P, lot, i, l) {
    delete l.estNote;
    const fk = IFCX.famsOfLine(P, lot, i); if (!fk.length) { l.estNote = 'aucune famille de la maquette associée'; return null; }
    let q = 0, any = false, rule = ''; const used = [];
    fk.forEach(k => { const F = P.ifc.fams[k]; if (!F) return; const r = IFCX.famQty(F, l.u, l.des); if (r.q == null) return; q += r.q; any = true; rule = r.how; used.push(F); });
    if (!any) { l.estNote = used.length ? '' : 'famille(s) associée(s), mais unité « ' + (l.u || '?') + ' » non mesurable sur la maquette'; return null; }
    const how = rule + ' sur la maquette IFC : ' + used.map(F => '« ' + F.lab + ' » (' + F.n + ')').join(', ');
    return { q: +q.toFixed(2), how, rooms: [], fams: fk };
  }
  function prepare(P) {
    if (P.source === 'ifc') {
      link(P);
      P.dpgf.forEach(d => d.lignes.forEach((l, i) => { l.est = ifcEstimate(P, d.lot, i, l); }));
      P.issues = issues(P, {});
      // ouvrages de la maquette qu'aucun article ne décrit (hors entourage)
      const sans = Object.entries(P.ifc.fams).filter(([k, F]) => !F.ent && !((P.assoc || {})[k] || {}).sans && !(((P.assoc || {})[k] || {}).arts || []).length);
      if (sans.length) P.issues.unshift({ niv: 'info', t: `${sans.length} famille(s) d’ouvrages de la maquette sans article du CCTP associé : ${sans.slice(0, 8).map(([, F]) => '« ' + F.lab + ' »').join(', ')}${sans.length > 8 ? '…' : ''}.`, q: 'Ces ouvrages sont-ils décrits dans un lot dont le CCTP manque au dossier, ou hors marché ?' });
      P.Q = {};
      return P;
    }
    link(P);
    const Q = quantities(P);
    P.dpgf.forEach(d => { const lot = P.cctp.find(c => c.lot === d.lot); d.lignes.forEach(l => { const a = lot && l.art ? lot.articles.find(x => x.num === l.art) : null; l.est = estimate(P, Q, l, a, (lot && lot.titre) || d.titre); }); });
    P.issues = issues(P, Q);
    P.Q = { wallsBy: Q.wallsBy, fpArea: Q.fpArea, slabArea: Q.slabArea, roofFlat: Q.roofFlat, roofPitch: Q.roofPitch, nExt: Q.extOpen.length, nInt: Q.intOpen.length };
    return P;
  }
  return { assemble, assembleIfc, ifcEstimate, preauPV, prepare, defaultRoofs, splitRoof, pruneUpper, canon, area2, perim, bbox, centroid, inPoly, wallLen };
})();

/* ---- m6_vue3d.js ---- */
/* ==================================================================================================
   DCE Educ — m6_vue3d : maquette 3D générique (Three.js r128)
   niveaux, dalles, murs typés, baies, locaux, poteaux, toitures, escaliers ; éclaté, coupes, sélection ;
   rendus : photoréaliste, crayon, bic, animé ; caméra perspective ou axonométrie.
   ================================================================================================== */
'use strict';
const V3 = (() => {
  let P = null, host = null, renderer, scene, camP, camO, cam, controls, ROOT, LG = [], PICK = [], ROOMS = [], clipMats = new Set(), ELM = new Map(), IM = null;
  const LIT = () => S.style === 'photo' || S.style === 'blanc' || S.style === 'anime';
  const CLIP = [], S = { style: 'blanc', proj: 'persp', explode: 0, mode: 'plein', sel: null, hover: null, filter: null, roofs: true, anim: null, onPick: null, onHover: null, layer: { site: true } };
  const LC = h => new THREE.Color(h).convertSRGBToLinear();
  const FN = {
    ens: '#5b87c9', adm: '#d38b4c', rest: '#ddb03f', san: '#3aa9a1', circ: '#9ba3ab', tech: '#c65a4c', rgt: '#879c5a', ext: '#a9bf8e', loge: '#9278c4', autre: '#b9a7d6'
  };
  const FNL = { ens: 'Enseignement / activités', adm: 'Bureaux, administration', rest: 'Restauration, cuisine', san: 'Sanitaires, vestiaires', circ: 'Circulations', tech: 'Locaux techniques', rgt: 'Rangements, entretien', ext: 'Extérieurs couverts', loge: 'Logement, séjour', autre: 'Autres locaux' };
  function fonction(n, ext) {
    const u = PDFX.norm(n);
    if (ext) return 'ext';
    if (/CLASSE|ATELIER|SALLE|BCD|BIBLIO|RASED|ETUDE|LABO|COURS|POLYVALENT|PLURIVALENT|DORTOIR|MOTRICITE/.test(u)) return 'ens';
    if (/BUREAU|\bB\b\.?|DIRECTION|ACCUEIL|SECRETARIAT|REPRO|ARCHIVE|MAITRES|PROFESSEUR|DETENTE|REUNION|REGIE|INFIRM/.test(u)) return 'adm';
    if (/REFECTOIRE|CUISINE|OFFICE|PLONGE|LEGUMERIE|RESTAUR|VAISS|CANTINE|SELF/.test(u)) return 'rest';
    if (/SANIT|WC|TOILETTE|DOUCHE|VESTIAIRE|VEST\b|SDB|SALLE D.?EAU|LAVABO/.test(u)) return 'san';
    if (/CIRCUL|HALL|DEGT|DEGAGEMENT|COULOIR|ESC|PALIER|ASCENSEUR|SAS|ENTREE|PASSAGE/.test(u)) return 'circ';
    if (/CHAUFFERIE|CTA|TGBT|ELEC|ONDULEUR|TECHNIQUE|LOCAL TECH|CONT|ORDURE|BUANDERIE|VENTIL|SOUS STATION|SERVEUR/.test(u)) return 'tech';
    if (/RGT|RANGEMENT|STOCK|MENAGE|ENTRETIEN|RESERVE|PLACARD|DEPOT|CELLIER|GARAGE/.test(u)) return 'rgt';
    if (/SEJOUR|CHAMBRE|CUISINE|SALON|LOGEMENT/.test(u)) return 'loge';
    return 'autre';
  }
  // couleurs de murs par famille (rendu photo)
  const WK = { bois: 0xc8a46a, ba: 0xbfbdb7, mac: 0xd8d2c4, cloi: 0xf2f0ec, doub: 0xf2efe6, met: 0x8d9399, autre: 0xe8e6e0 };
  // habillages lus sur les façades : couleur de repli, texture, rugosité, métal
  const FMAT = { zinc: { c: 0x86967f, tex: 'zincR', r: 0.45, m: 0.35 }, bois: { c: 0x9c3a26, tex: 'bardage', r: 0.8, m: 0 }, enduit: { c: 0xefede8, tex: 'enduit', r: 0.95, m: 0 }, gris: { c: 0xa9aaa6, tex: 'enduit', r: 0.9, m: 0 } };
  const WCAP = { bois: 0xb98a4a, ba: 0x5f646a, mac: 0x9c6b52, cloi: 0x2b2f33, doub: 0x9aa0a6, met: 0x3d4247, autre: 0x777777 };

  // ------------------------------------------------------------------ textures procédurales
  function canvasTex(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
  let TEX = null;
  function textures() {
    if (TEX) return TEX;
    TEX = {
      zinc: canvasTex(64, 64, (g, w, h) => { g.fillStyle = '#8a9a86'; g.fillRect(0, 0, w, h); g.fillStyle = '#76866f'; g.fillRect(0, 0, 3, h); g.fillStyle = '#a0b09a'; g.fillRect(3, 0, 2, h); }),
      enduit: canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#ecebe6'; g.fillRect(0, 0, w, h); for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.035})`; g.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5); } }),
      bois: canvasTex(64, 64, (g, w, h) => { g.fillStyle = '#b07a48'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 8) { g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(x, 0, 1, h); } }),
      sol: canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#d9d6cf'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(0,0,0,.06)'; for (let x = 0; x <= w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.beginPath(); g.moveTo(0, x); g.lineTo(w, x); g.stroke(); } }),
      zincR: canvasTex(64, 64, (g, w, h) => { g.fillStyle = '#e6e6e6'; g.fillRect(0, 0, w, h); g.fillStyle = '#b4b4b4'; g.fillRect(0, 0, 3, h); g.fillStyle = '#ffffff'; g.fillRect(3, 0, 2, h); }),
      bardage: canvasTex(64, 64, (g, w, h) => { g.fillStyle = '#ececec'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 16) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x, 0, 3, h); g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(x + 3, 0, 2, h); } }),
      papier: canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#f7f4ec'; g.fillRect(0, 0, w, h); for (let i = 0; i < 5000; i++) { g.fillStyle = `rgba(90,80,60,${Math.random() * 0.05})`; g.fillRect(Math.random() * w, Math.random() * h, 1, 1); } })
    };
    return TEX;
  }

  // ------------------------------------------------------------------ matériaux selon le style (crayon / bic : hachures en espace écran)
  const INK = { crayon: [0.22, 0.22, 0.22], bic: [0.12, 0.22, 0.58] };
  function npr(m) {
    if (S.style !== 'crayon' && S.style !== 'bic') return m;
    const ink = INK[S.style], dense = S.style === 'bic' ? 1.35 : 1.0;
    m.onBeforeCompile = sh => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `
        #include <dithering_fragment>
        {
          float L = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
          vec2 q = gl_FragCoord.xy;
          float sp = ${(6.0 / dense).toFixed(2)};
          float h1 = step(0.82, fract((q.x + q.y) / sp));
          float h2 = step(0.84, fract((q.x - q.y) / (sp * 0.9)));
          float h3 = step(0.86, fract(q.y / (sp * 0.8)));
          float n = fract(sin(dot(floor(q / 2.0), vec2(12.9898, 78.233))) * 43758.5453);
          float hatch = 0.0;
          if (L < 0.78) hatch = max(hatch, h1);
          if (L < 0.55) hatch = max(hatch, h2);
          if (L < 0.32) hatch = max(hatch, h3);
          hatch *= 0.55 + 0.45 * n;
          vec3 paper = vec3(0.975, 0.965, 0.935);
          gl_FragColor = vec4(mix(paper, vec3(${ink.join(',')}), hatch * 0.85), gl_FragColor.a);
        }`);
    };
    m.customProgramCacheKey = () => 'npr-' + S.style;
    return m;
  }
  function cm(m) { m.clippingPlanes = CLIP; m.clipShadows = true; clipMats.add(m); return npr(m); }
  function std(color, o) {
    o = Object.assign({ roughness: 0.85, metalness: 0 }, o || {});
    if (S.style === 'blanc') {
      const glass = o.metalness >= 0.5, c = new THREE.Color(color), l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      if (glass) { o = Object.assign({ roughness: 0.08, metalness: 0.35, envMapIntensity: 1.2 }, o.side != null ? { side: o.side } : {}); color = 0x9fb0bd; }
      else { const v = Math.round(225 + 26 * Math.min(1, l * 1.2)); color = (v << 16) | (v << 8) | Math.max(0, v - 4); o = Object.assign({ roughness: 0.9, metalness: 0 }, o.side != null ? { side: o.side } : {}); }
    }
    const m = new THREE.MeshStandardMaterial(o); m.color = LC(color); return cm(m);
  }
  function capMat(color) { return cm(new THREE.MeshBasicMaterial({ color: (S.style === 'crayon' || S.style === 'bic') ? new THREE.Color(...INK[S.style]) : LC(color), side: THREE.BackSide })); }
  function lineMat(op) { const ink = INK[S.style]; const m = new THREE.LineBasicMaterial({ color: ink ? new THREE.Color(...ink) : 0x1e2327, transparent: true, opacity: ink ? Math.min(1, op * 3) : op, depthWrite: false }); m.clippingPlanes = CLIP; clipMats.add(m); return m; }

  // ------------------------------------------------------------------ géométrie
  const shapeOf = (ring, holes) => { const s = new THREE.Shape(ring.map(p => new THREE.Vector2(p[0], p[1]))); (holes || []).forEach(h => s.holes.push(new THREE.Path(h.map(p => new THREE.Vector2(p[0], p[1]))))); return s; };
  function extrude(shapes, y0, h) { const g = new THREE.ExtrudeGeometry(shapes, { depth: h, bevelEnabled: false, curveSegments: 1 }); g.rotateX(Math.PI / 2); g.translate(0, y0 + h, 0); g.computeVertexNormals(); return g; }
  function edges(group, geo, op = 0.25, ang = 25) {
    const ink = INK[S.style];
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(geo, ang), lineMat(op)); group.add(l);
    if (ink) { // trait « à main levée » : deuxième passe légèrement décalée
      const e2 = new THREE.EdgesGeometry(geo, ang), p = e2.attributes.position;
      for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + (Math.random() - 0.5) * 0.06, p.getY(i) + (Math.random() - 0.5) * 0.04, p.getZ(i) + (Math.random() - 0.5) * 0.06);
      const l2 = new THREE.LineSegments(e2, lineMat(op * 0.6)); group.add(l2);
    }
    return l;
  }
  function addSolid(group, geo, mat, cap, info, shadow = true) {
    const m = new THREE.Mesh(geo, mat); m.castShadow = shadow && LIT(); m.receiveShadow = LIT(); m.userData = info || {};
    group.add(m); if (cap) { const k = new THREE.Mesh(geo, cap); k.renderOrder = 1; group.add(k); group.userData.caps = (group.userData.caps || []).concat(k); }
    if (info) PICK.push(m); (group.userData.fills = group.userData.fills || []).push(m); return m;
  }
  function boxesGeo(B) {
    if (!B.length) return null;
    const n = B.length * 36, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2); let o = 0;
    B.forEach(b => {
      const g = new THREE.BoxGeometry(b.len, b.y1 - b.y0, b.thk).toNonIndexed(); g.rotateY(-b.ang); g.translate(b.cx, (b.y0 + b.y1) / 2, b.cz);
      const P_ = g.attributes.position.array, N_ = g.attributes.normal.array;
      for (let i = 0; i < P_.length / 3; i++, o++) {
        const x = P_[3 * i], y = P_[3 * i + 1], zz = P_[3 * i + 2], nx = N_[3 * i], ny = N_[3 * i + 1], nz = N_[3 * i + 2];
        pos[3 * o] = x; pos[3 * o + 1] = y; pos[3 * o + 2] = zz; nor[3 * o] = nx; nor[3 * o + 1] = ny; nor[3 * o + 2] = nz;
        // projection selon la face : murs = (abscisse le long du mur, hauteur), dessus = (x, z)
        const c = Math.cos(b.ang), sn = Math.sin(b.ang), endF = Math.abs(nx * c + nz * sn) > 0.5;
        if (Math.abs(ny) > 0.5) { uv[2 * o] = x / 2; uv[2 * o + 1] = zz / 2; } else { uv[2 * o] = (endF ? -x * sn + zz * c : x * c + zz * sn) / 2; uv[2 * o + 1] = y / 2; }
      }
      g.dispose();
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o * 3), 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, o * 3), 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, o * 2), 2)); return g;
  }
  const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  function prismGeo(L) {
    const pos = [], v = (p, y) => [p[0], y, p[1]];
    L.forEach(({ pts, y0, y1 }) => {
      const s2 = Math.sign(PROJ.area2(pts)) || 1, Q = s2 > 0 ? pts : pts.slice().reverse(), n = Q.length;
      for (let i = 1; i < n - 1; i++) { pos.push(...v(Q[0], y1), ...v(Q[i + 1], y1), ...v(Q[i], y1), ...v(Q[0], y0), ...v(Q[i], y0), ...v(Q[i + 1], y0)); }
      for (let i = 0; i < n; i++) { const a = Q[i], b = Q[(i + 1) % n]; pos.push(...v(a, y0), ...v(b, y0), ...v(b, y1), ...v(a, y0), ...v(b, y1), ...v(a, y1)); }
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  }
  // toiture d'un bloc : terrasse, deux pans (faîtage selon le grand axe du rectangle orienté) ou quatre pans
  function roofGeo(r) {
    const o = r.o, z = r.z;
    if (r.type === 'terrasse') return { g: extrude([shapeOf(o)], z - 0.3, 0.3), flat: true };
    if (r.type === 'auvent') return { g: extrude([shapeOf(o)], z - 0.2, 0.2), flat: true, auvent: true };
    // rectangle orienté minimal (sur les directions des arêtes)
    let best = null;
    for (let i = 0; i < o.length; i++) {
      const a = o[i], b = o[(i + 1) % o.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
      o.forEach(p => { const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); });
      const A = (u1 - u0) * (v1 - v0); if (!best || A < best.A) best = { A, ux, uy, u0, u1, v0, v1 };
    }
    let { ux, uy, u0, u1, v0, v1 } = best;
    const swap = r.ridgeDir ? Math.abs(ux * r.ridgeDir[0] + uy * r.ridgeDir[1]) < Math.abs(-uy * r.ridgeDir[0] + ux * r.ridgeDir[1]) : (r.axis === 'court' ? (u1 - u0) > (v1 - v0) : (u1 - u0) < (v1 - v0));
    if (swap) { [ux, uy] = [-uy, ux]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }
    const ov = r.ov != null ? r.ov : 0.3, sl = (r.slope || 30) / 100, hw = (v1 - v0) / 2 + ov, vc = (v0 + v1) / 2, rise = sl * hw;
    const P = (u, v, y) => [u * ux - v * uy, y, u * uy + v * ux];
    const pos = [], tri = (A, B, C) => pos.push(...A, ...B, ...C);
    const e0 = z - sl * ov, top = z + sl * (hw - ov);
    const a = P(u0 - ov, v0 - ov, e0), b = P(u1 + ov, v0 - ov, e0), c = P(u1 + ov, v1 + ov, e0), d = P(u0 - ov, v1 + ov, e0);
    if (r.type === '4pans') {
      const L = (u1 - u0) / 2 + ov, inset = Math.min(hw, L), uc = (u0 + u1) / 2;
      const r1 = P(uc - L + inset, vc, top), r2 = P(uc + L - inset, vc, top);
      tri(a, b, r2); tri(a, r2, r1); tri(c, d, r1); tri(c, r1, r2); tri(b, c, r2); tri(d, a, r1);
    } else {
      const r1 = P(u0 - ov, vc, top), r2 = P(u1 + ov, vc, top);
      tri(a, b, r2); tri(a, r2, r1); tri(c, d, r1); tri(c, r1, r2);
      // pignons
      const g1 = P(u0, v0, z), g2 = P(u0, v1, z), g3 = P(u0, vc, z + sl * (hw - ov)), h1 = P(u1, v0, z), h2 = P(u1, v1, z), h3 = P(u1, vc, z + sl * (hw - ov));
      tri(g1, g2, g3); tri(h1, h3, h2);
    }
    // triangles tournés vers l'extérieur (sinon le post-traitement « voit » sous la toiture)
    { let cx = 0, cy = 0, cz = 0; const nv = pos.length / 3; for (let i = 0; i < pos.length; i += 3) { cx += pos[i]; cy += pos[i + 1]; cz += pos[i + 2]; } cx /= nv; cy = Math.min(cy / nv, z); cz /= nv;
      for (let i = 0; i < pos.length; i += 9) {
        const ax = pos[i], ay = pos[i + 1], az = pos[i + 2], bx = pos[i + 3] - ax, by = pos[i + 4] - ay, bz = pos[i + 5] - az, qx = pos[i + 6] - ax, qy = pos[i + 7] - ay, qz = pos[i + 8] - az;
        const nx = by * qz - bz * qy, ny = bz * qx - bx * qz, nz = bx * qy - by * qx, mx = ax + (bx + qx) / 3 - cx, my = ay + (by + qy) / 3 - cy, mz = az + (bz + qz) / 3 - cz;
        if (nx * mx + ny * my + nz * mz < 0) for (let k = 0; k < 3; k++) { const t = pos[i + 3 + k]; pos[i + 3 + k] = pos[i + 6 + k]; pos[i + 6 + k] = t; }
      } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const uv = []; for (let i = 0; i < pos.length; i += 3) uv.push((pos[i] * ux + pos[i + 2] * uy) / 0.55, pos[i + 1] / 3); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals(); return { g, flat: false, ridge: top };
  }

  // ------------------------------------------------------------------ construction de la scène
  function init(el) {
    host = el;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    THREE.ColorManagement.enabled = false;   // couleurs converties à la main (LC), comme dans la version 1
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.localClippingEnabled = true;
    el.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camP = new THREE.PerspectiveCamera(38, 1, 0.3, 3000); camO = new THREE.OrthographicCamera(-50, 50, 50, -50, -1000, 3000); cam = camP;
    controls = new THREE.OrbitControls(cam, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = 0.08; controls.maxPolarAngle = Math.PI * 0.495; controls.screenSpacePanning = true;
    RO = new ResizeObserver(resize); RO.observe(el); resize();
    pickEvents();
    // éclairage d'ambiance (reflets des vitrages, zinc) et post-traitement : occlusion ambiante (GTAO) sur le rendu photo
    try { const pm = new THREE.PMREMGenerator(renderer); ENV = pm.fromScene(new THREE.RoomEnvironment(), 0.04).texture; } catch (e) { ENV = null; }
    try {
      const rt = new THREE.WebGLRenderTarget(800, 600, { type: THREE.HalfFloatType, samples: 4 });
      composer = new THREE.EffectComposer(renderer, rt);
      rpass = new THREE.RenderPass(scene, cam); composer.addPass(rpass);
      gtao = new THREE.GTAOPass(scene, cam, 800, 600); gtao.output = THREE.GTAOPass.OUTPUT.Default;
      gtao.updateGtaoMaterial({ radius: 1.1, distanceExponent: 1.5, thickness: 1.5, scale: 1.6 }); gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6 });
      composer.addPass(gtao); composer.addPass(new THREE.OutputPass());
    } catch (e) { composer = null; console.warn('post-traitement indisponible', e); }
    requestAnimationFrame(loop);
  }
  // le panneau d'outils masque la gauche de la vue : on décale le centre optique vers la droite
  // la vue 3D change de place (onglet Maquette 3D ↔ onglet Associations) : même rendu, même caméra
  let RO = null;
  function attachTo(el) { if (!renderer || !el || host === el) return; host = el; el.appendChild(renderer.domElement); if (RO) RO.observe(el); requestAnimationFrame(resize); }
  function sideOff(w) { if (host && host.id !== 'v3host') return 0; const t = document.getElementById('tools'); return (w > 900 && t && t.offsetWidth) ? Math.min(340, t.offsetWidth + 16) : 0; }
  function resize() { if (!host) return; const w = host.clientWidth || 800, h = host.clientHeight || 600, off = sideOff(w); renderer.setSize(w, h); if (composer) { composer.setSize(w, h); } camP.aspect = (w + off) / h; if (off) camP.setViewOffset(w + off, h, 0, 0, w, h); else camP.clearViewOffset(); camP.updateProjectionMatrix(); fitOrtho(); }
  function fitOrtho() { const w = host.clientWidth || 800, h = host.clientHeight || 600, d = camO.userData.span || 60, off = sideOff(w); camO.left = -d * (w + off) / h / 2; camO.right = d * (w + off) / h / 2; camO.top = d / 2; camO.bottom = -d / 2; if (off) camO.setViewOffset(w + off, h, 0, 0, w, h); else camO.clearViewOffset(); camO.updateProjectionMatrix(); }
  let B = { x0: 0, y0: 0, x1: 50, y1: 50 }, CX = 25, CZ = 25, ENV = null, composer = null, rpass = null, gtao = null;
  function build(proj) {
    P = proj || P; if (!P) return;
    textures();
    if (ROOT) { ROOT.traverse(o => { if (o.geometry) o.geometry.dispose(); }); scene.remove(ROOT); }
    scene.children.filter(o => o.isLight).forEach(o => scene.remove(o));
    clipMats.clear(); PICK = []; ROOMS = []; LG = []; ELM = new Map();
    ROOT = new THREE.Group(); scene.add(ROOT);
    // maquette IFC : la géométrie du fichier, en mémoire (IFCX.RT), est la seule source de la 3D
    const rt = P.source === 'ifc' && typeof IFCX !== 'undefined' && IFCX.RT && P.ifc && IFCX.RT.nom === P.ifc.nom ? IFCX.RT : null;
    const pts = rt ? ifcPlanBox(rt) : P.fp.flatMap(f => f.o).concat(P.rooms.flatMap(r => r.polys.flat()));
    B = PROJ.bbox(pts.length ? pts : [[0, 0], [30, 30]]); CX = (B.x0 + B.x1) / 2; CZ = (B.y0 + B.y1) / 2;
    const span = Math.max(B.x1 - B.x0, B.y1 - B.y0);
    camO.userData.span = span * 1.2; fitOrtho();
    // lumière et fond selon le style
    const photo = LIT();
    const blanc = S.style === 'blanc';
    renderer.toneMappingExposure = blanc ? 0.86 : photo ? 1.05 : 1.0;
    renderer.shadowMap.enabled = photo;
    const hemi = new THREE.HemisphereLight(0xf4f6ff, 0x8a8f80, (blanc ? 0.32 : photo ? 0.5 : 0.9) * Math.PI); scene.add(hemi);
    scene.environment = photo ? ENV : null; scene.environmentIntensity = 0.35;
    const sun = new THREE.DirectionalLight(0xfff3e2, (blanc ? 1.7 : photo ? 1.2 : 0.8) * Math.PI); sun.position.set(CX - span, span * 1.3, CZ + span); sun.target.position.set(CX, 0, CZ);
    sun.castShadow = photo; sun.shadow.mapSize.set(4096, 4096); Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 5 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target); scene.add(new THREE.AmbientLight(0xffffff, (blanc ? 0.05 : photo ? 0.08 : 0.25) * Math.PI));
    host.style.background = photo ? '' : (S.style === 'bic' ? '#fbfaf4 repeating-linear-gradient(0deg, transparent 0 27px, rgba(70,110,200,.13) 27px 28px)' : '#f7f4ec');
    // ciel clair dans tous les thèmes (comme une fenêtre de logiciel de CAO) ; le brouillard fond l'horizon du sol
    const skyC = blanc ? 0xd3d8dc : photo ? 0xdfe7ee : (S.style === 'bic' ? 0xfbfaf4 : 0xf7f4ec);
    scene.background = photo ? LC(skyC) : null;
    scene.fog = new THREE.Fog(photo ? LC(skyC) : new THREE.Color(skyC), span * 2.2, span * 5.5);
    // sol
    if (S.layer.site) {
      const gm = photo ? new THREE.MeshStandardMaterial({ color: LC(blanc ? 0xc9ccc6 : 0xdfe5d6), roughness: 1 }) : npr(new THREE.MeshLambertMaterial({ color: 0xffffff }));
      const ground = new THREE.Mesh(new THREE.CircleGeometry(span * 8, 72), gm); ground.rotation.x = -Math.PI / 2; ground.position.set(CX, rt ? rt.zmin - 0.03 : -0.17, CZ); ground.receiveShadow = photo; ROOT.add(ground);
    }
    if (P.source === 'ifc') { if (rt) buildIfc(rt, photo); applyLook(); placeLevels(); return; }   // sans fichier en mémoire : rien d'autre à montrer
    // niveaux
    P.levels.forEach((L, i) => {
      const G = new THREE.Group(); G.userData.lev = i; LG.push(G); ROOT.add(G);
      const nx = P.levels[i + 1], z = L.z, top = nx ? nx.z - (nx.slab || 0.25) : z + L.h, topL = top;
      // dalle / plancher
      const fps = P.fp.filter(f => f.lev === i);
      if (fps.length) {
        const g = i === 0 ? extrude(fps.map(f => shapeOf(f.o)), z - 0.16, 0.16) : extrude(fps.map(f => shapeOf(f.o)), z - (L.slab || 0.25), L.slab || 0.25);
        addSolid(G, g, std(0xd2d1cc, { map: photo ? TEX.sol : null }), capMat(0x7a7d80), { kind: 'dalle', lev: i }, i > 0); edges(G, g, 0.3, 30);
      }
      // murs : un volume droit par mur (axe, épaisseur), regroupés par matériau ; anciens projets : contours extrudés
      const wallGroups = {}, oldGroups = {}, levOpen = P.open.filter(o => o.lev === i);
      levOpen.forEach(o => { delete o._c; delete o._t; delete o._k; delete o._top; });
      P.walls.filter(w => w.lev === i).forEach(w => {
        const kind = (P.wtypes[w.t] || {}).kind || 'autre';
        const key = LIT() ? (w.mat && S.style !== 'blanc' ? 'F:' + w.mat + ':' + (w.fcol || []).join(',') : (w.ext ? 'X:' + kind : 'K:' + (kind === 'ba' || kind === 'mac' ? kind : 'cloi'))) : 'N:' + kind;
        if (w.a && w.b && w.th) {
          const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]); if (L < 0.05) return;
          const ux = (w.b[0] - w.a[0]) / L, uz = (w.b[1] - w.a[1]) / L, ang = Math.atan2(uz, ux);
          // baies qui traversent ce mur (tirées des façades, ou lues sur le plan sans interruption du dessin) : le mur est découpé
          const cuts = [];
          levOpen.forEach(o => {
            if (Math.abs(Math.sin(o.a - ang)) > 0.2) return;
            const rx = o.c[0] - w.a[0], rz = o.c[1] - w.a[1], s = rx * ux + rz * uz, d = Math.abs(-rx * uz + rz * ux);
            if (d > w.th / 2 + 0.3 || s < -o.w / 2 + 0.05 || s > L + o.w / 2 - 0.05) return;
            const s0 = Math.max(0, s - o.w / 2), s1 = Math.min(L, s + o.w / 2); if (s1 - s0 < 0.2) return;
            cuts.push([s0, s1]); o._c = [w.a[0] + ux * s, w.a[1] + uz * s]; o._t = w.th; o._k = key; o._top = w.ht != null ? z + w.ht : null;   // la baie se place dans l'axe du mur
          });
          cuts.sort((p, q) => p[0] - q[0]);
          let s = 0; const pieces = [];
          cuts.forEach(([c0, c1]) => { if (c0 - s > 0.02) pieces.push([s, c0]); s = Math.max(s, c1); });
          if (L - s > 0.02) pieces.push([s, L]);
          pieces.forEach(([p0, p1]) => (wallGroups[key] = wallGroups[key] || []).push({ cx: w.a[0] + ux * (p0 + p1) / 2, cz: w.a[1] + uz * (p0 + p1) / 2, ang, len: p1 - p0, thk: w.th, y0: z, y1: w.ht != null ? z + w.ht : top, w }));
        } else (oldGroups[key] = oldGroups[key] || []).push(shapeOf(w.o, w.h));
      });
      const wallMat = key => {
        if (S.style !== 'photo') return npr(cm(new THREE.MeshLambertMaterial({ color: 0xffffff })));
        const [k0, k1, k2] = key.split(':');
        if (k0 === 'F') { const fc = k2 ? k2.split(',').map(Number) : null, base = fc && fc.length === 3 ? (fc[0] << 16) | (fc[1] << 8) | fc[2] : FMAT[k1].c; return std(base, { map: TEX[FMAT[k1].tex], roughness: FMAT[k1].r, metalness: FMAT[k1].m }); }
        if (k0 === 'X') return std(0xeeece6, { map: TEX.enduit, roughness: 0.92 });                    // façade sans relevé : enduit clair
        return std(k1 === 'ba' ? 0xc9c7c1 : k1 === 'mac' ? 0xdcd6ca : 0xf1efea, { map: TEX.enduit, roughness: 0.92 });
      };
      Object.keys(wallGroups).forEach(key => {
        const g = boxesGeo(wallGroups[key]), kind = key.split(':')[1];
        const m = addSolid(G, g, wallMat(key), capMat(WCAP[kind] || 0x777777), { kind: 'mur', lev: i, t: null, mat: key.startsWith('F:') ? key.split(':')[1] : null, kindMur: kind }); edges(G, g, 0.2, 30);
        m.userData.walls = wallGroups[key].map(b => b.w);
      });
      Object.keys(oldGroups).forEach(key => { const g = extrude(oldGroups[key], z, top - z); addSolid(G, g, wallMat(key), capMat(0x777777), { kind: 'mur', lev: i }); edges(G, g, 0.22, 30); });
      // baies : allège et linteau dans l'épaisseur du mur, menuiserie (cadre, montants, vitrage), vantail des portes
      const Bx = {}, FR = [], GL = [], LV = [];
      P.open.filter(o => o.lev === i).forEach(o => {
        const top = o._top || topL;   // mur plus bas que l'étage (annexe) : la baie et son linteau s'arrêtent sous sa tête
        const dims = openingDims(o, top - z), hh = Math.max(0.3, Math.min(dims.h, top - z - dims.sill - 0.02)), y0 = z + dims.sill, y1 = y0 + hh;
        const oc = o._c || o.c, th = Math.max(0.08, o._t || o.t || 0.2), base = { cx: oc[0], cz: oc[1], ang: o.a };
        const bk = o._k || (o.ext ? 'X:autre' : 'K:cloi'); (Bx[bk] = Bx[bk] || []);
        if (dims.sill > 0.02) Bx[bk].push(Object.assign({ y0: z, y1: y0, len: o.w + 0.01, thk: th }, base));
        if (top - y1 > 0.02) Bx[bk].push(Object.assign({ y0: y1, y1: top, len: o.w + 0.01, thk: th }, base));
        const ca = Math.cos(o.a), sa = Math.sin(o.a), at = (s, yA, yB, len, thk, arr) => arr.push({ cx: oc[0] + ca * s, cz: oc[1] + sa * s, ang: o.a, len, thk, y0: yA, y1: yB });
        const fw = 0.06, fd = Math.min(0.08, th * 0.6);
        // cadre (dormant)
        at(-o.w / 2 + fw / 2, y0, y1, fw, fd, FR); at(o.w / 2 - fw / 2, y0, y1, fw, fd, FR); at(0, y1 - fw, y1, o.w, fd, FR);
        if (dims.kind !== 'porte') at(0, y0, y0 + fw, o.w, fd, FR);
        if (dims.kind === 'porte') {   // vantail plein (un ou deux)
          const two = o.w > 1.35, n = two ? 2 : 1, lw = (o.w - 2 * fw) / n;
          for (let k = 0; k < n; k++) at(-o.w / 2 + fw + lw * (k + 0.5), y0, y1 - fw, lw - 0.01, 0.04, LV);
        } else {                        // vitrage, avec montants tous les 1,25 m environ
          const nm = Math.max(0, Math.round(o.w / 1.25) - 1);
          for (let k = 1; k <= nm; k++) at(-o.w / 2 + o.w * k / (nm + 1), y0, y1, 0.05, fd, FR);
          if (hh > 2.6 && dims.full) at(0, y0 + 2.2, y0 + 2.25, o.w, fd, FR);
          at(0, y0 + fw, y1 - fw, o.w - 2 * fw, 0.02, GL);
        }
      });
      Object.keys(Bx).forEach(bk => { const og = boxesGeo(Bx[bk]); if (og) { addSolid(G, og, wallMat(bk), capMat(0x777777), { kind: 'linteaux', lev: i }); edges(G, og, 0.18, 30); } });
      const frG = boxesGeo(FR); if (frG) { const m = new THREE.Mesh(frG, LIT() ? std(0x3b4046, { roughness: 0.45, metalness: 0.5 }) : npr(cm(new THREE.MeshLambertMaterial({ color: 0x8a8f94 })))); m.castShadow = LIT(); m.userData = { kind: 'menuiserie', lev: i }; G.add(m); }
      const glG = boxesGeo(GL); if (glG) { const m = new THREE.Mesh(glG, LIT() ? std(0x223142, { roughness: 0.04, metalness: 0.7, envMapIntensity: 1.6 }) : npr(cm(new THREE.MeshLambertMaterial({ color: 0xc9d1d8 })))); m.userData = { kind: 'baie', lev: i }; PICK.push(m); G.add(m); }
      const lvG = boxesGeo(LV); if (lvG) { const m = new THREE.Mesh(lvG, LIT() ? std(0xa37a4f, { map: TEX.bois, roughness: 0.7 }) : npr(cm(new THREE.MeshLambertMaterial({ color: 0xffffff })))); m.castShadow = LIT(); m.userData = { kind: 'porte', lev: i }; G.add(m); edges(G, lvG, 0.15, 30); }
      // poteaux
      P.cols.filter(c => c.lev === i).forEach(c => { const h = c.h != null ? c.h : top - z, g = new THREE.CylinderGeometry(c.d / 2, c.d / 2, h, 14); g.translate(c.c[0], z + h / 2, c.c[1]); addSolid(G, g, photo ? std(0xd9d8d3) : npr(cm(new THREE.MeshLambertMaterial({ color: 0xffffff }))), null, { kind: 'poteau', c }); });
      // locaux (sols colorés + volumes pour la sélection)
      P.rooms.filter(r => r.lev === i).forEach(r => {
        const f = r.f || (r.f = fonction(r.n, r.ext)), col = LC(FN[f] || '#bbb');
        const sh = r.polys.map(p => shapeOf(p));
        const floorMat = photo ? std(0xffffff, { roughness: 0.95 }) : npr(cm(new THREE.MeshLambertMaterial({ color: 0xffffff })));
        if (photo) floorMat.color.copy(col.clone().lerp(new THREE.Color(1, 1, 1), 0.5));
        const floor = new THREE.Mesh(extrude(sh, z + 0.005, 0.03), floorMat); floor.receiveShadow = photo; G.add(floor);
        const hv = r.hs ? r.hs[1] : (r.ext ? 2.8 : 2.5);
        const vm = cm(new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, emissive: col, emissiveIntensity: 0.1 }));
        const vol = new THREE.Mesh(extrude(sh, z + 0.05, hv - 0.06), vm); vol.visible = false; vol.renderOrder = 3; G.add(vol);
        const R = { r, lev: i, floor, vol, vm, floorMat, base: col, hv, z };
        vol.userData = { kind: 'local', R }; ROOMS.push(R); PICK.push(vol);
      });
    });
    // toitures (groupe à part pour l'éclaté)
    const RG = new THREE.Group(); RG.userData.lev = P.levels.length; LG.push(RG); ROOT.add(RG);
    P.roofs.forEach(r => {
      if (r.type === 'auvent') { auvent(RG, r, photo); return; }
      const { g, flat } = roofGeo(r);
      const zc = r.fcol && r.fcol.length === 3 ? (r.fcol[0] << 16) | (r.fcol[1] << 8) | r.fcol[2] : 0x86967f;
      const mat = photo ? (flat ? std(0xb9bbb6, { map: TEX.enduit, roughness: 0.95 }) : std(zc, { map: TEX.zincR, roughness: 0.45, metalness: 0.35, side: THREE.DoubleSide })) : npr(cm(new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide })));
      addSolid(RG, g, mat, flat ? capMat(0x7a7d80) : null, { kind: 'toiture', r }); edges(RG, g, 0.3, 20);
    });
    // escaliers
    // escaliers : marches au nombre lu sur le plan ; extérieurs en métal (marches en tôle sur deux limons), intérieurs en béton
    (P.stairs || []).forEach(st => {
      const L = [], met = !!st.ext;
      st.parts.forEach(pt => {
        if (pt.k === 'pal') { L.push({ pts: pt.q, y0: pt.z - (met ? 0.08 : 0.22), y1: pt.z }); return; }
        const [i, j] = pt.dir, Ta = pt.q[i], Tb = pt.q[j], Ba = pt.q[(i + 3) % 4], Bb = pt.q[(j + 1) % 4], nR = pt.n || Math.max(2, Math.round((pt.z1 - pt.z0) / 0.17)), rise = (pt.z1 - pt.z0) / nR;
        const wd = Math.hypot(Bb[0] - Ba[0], Bb[1] - Ba[1]) || 1, e = [(Bb[0] - Ba[0]) / wd * 0.07, (Bb[1] - Ba[1]) / wd * 0.07], add = (p, s) => [p[0] + e[0] * s, p[1] + e[1] * s];
        for (let k = 0; k < nR; k++) {
          const top = pt.z0 + (k + 1) * rise, a0 = lerp2(Ba, Ta, k / nR), a1 = lerp2(Ba, Ta, (k + 1) / nR), b0 = lerp2(Bb, Tb, k / nR), b1 = lerp2(Bb, Tb, (k + 1) / nR);
          if (!met) { L.push({ pts: [a0, b0, b1, a1], y0: Math.max(pt.z0 - 0.05, top - 0.42), y1: top }); continue; }
          L.push({ pts: [add(a0, 1), add(b0, -1), add(b1, -1), add(a1, 1)], y0: top - 0.05, y1: top });                  // marche en tôle
          L.push({ pts: [a0, add(a0, 1), add(a1, 1), a1], y0: Math.max(pt.z0 - 0.3, top - 0.34), y1: top + 0.02 });       // limons (en redans)
          L.push({ pts: [add(b0, -1), b0, b1, add(b1, -1)], y0: Math.max(pt.z0 - 0.3, top - 0.34), y1: top + 0.02 });
        }
      });
      const mat = met ? (photo ? std(0x6c747c, { roughness: 0.45, metalness: 0.55, side: THREE.DoubleSide }) : npr(cm(new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }))))
        : (photo ? std(0xd8d5cf, { side: THREE.DoubleSide }) : npr(cm(new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }))));
      const g = prismGeo(L); addSolid(LG[0], g, mat, null, { kind: 'escalier', st }); edges(LG[0], g, 0.25, 30);
    });
    applyLook(); placeLevels();
  }
  // ------------------------------------------------------------------ maquette IFC
  // repère : plan = (X − Ox, −(Y − Oy)), hauteur = Z ; dans la scène (x, y, z) = (plan x, Z, plan y)
  function ifcPlanBox(rt) {
    if (!rt.box) {
      const O = P.ifc.O; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, z0 = 1e9;
      rt.G.objets.forEach(o => { if (o.ty === 'IFCSITE') return; o.parts.forEach(p => { const t = p.t; for (let i = 0; i < t.length; i += 3) { const x = t[i], y = t[i + 1], z = t[i + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; } }); });
      rt.box = [[x0 - O[0], -(y1 - O[1])], [x1 - O[0], -(y0 - O[1])]]; rt.zmin = z0;
    }
    return rt.box;
  }
  const KIND = c => /SLAB/.test(c) ? 'dalle' : /ROOF/.test(c) ? 'toiture' : /WALL|BEAM/.test(c) ? 'mur' : /COLUMN/.test(c) ? 'poteau' : /STAIR|RAMP|RAILING/.test(c) ? 'escalier' : /DOOR|WINDOW|PLATE|MEMBER|CURTAIN/.test(c) ? 'baie' : 'equip';
  function ifcMats(photo) {
    const blanc = S.style === 'blanc';
    const base = photo && !blanc ? (() => { const m = std(0xffffff, { roughness: 0.82 }); m.vertexColors = true; return m; })() : (photo ? std(0xe9e8e4, { roughness: 0.9 }) : npr(cm(new THREE.MeshLambertMaterial({ color: 0xffffff }))));
    const glass = photo ? std(blanc ? 0x9fb0bd : 0x2a3a4c, { roughness: 0.05, metalness: 0.7, envMapIntensity: 1.6 }) : npr(cm(new THREE.MeshLambertMaterial({ color: 0xd7dde2 })));
    glass.transparent = true; glass.opacity = 0.55; glass.depthWrite = false;
    const ghost = m => { const g = m.clone(); g.transparent = true; g.opacity = 0.1; g.depthWrite = false; if (m.onBeforeCompile) { g.onBeforeCompile = m.onBeforeCompile; g.customProgramCacheKey = m.customProgramCacheKey; } g.clippingPlanes = CLIP; clipMats.add(g); return g; };
    const hi = std(0x2f6fd6, { roughness: 0.6 }); hi.emissive = LC(0x2f6fd6); hi.emissiveIntensity = 0.35;
    const sel = std(0xe0662b, { roughness: 0.6 }); sel.emissive = LC(0xe0662b); sel.emissiveIntensity = 0.4;
    return { n: base, g: ghost(base), nG: glass, gG: ghost(glass), h: hi, s: sel };
  }
  function buildIfc(rt, photo) {
    const M = P.ifc, O = M.O, nL = P.levels.length; IM = ifcMats(photo);
    for (let i = 0; i <= nL; i++) { const G = new THREE.Group(); G.userData.lev = i; LG.push(G); ROOT.add(G); }
    const lin = c => { const k = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); return [k(c[0]), k(c[1]), k(c[2])]; };
    rt.G.objets.forEach((o, k) => {
      const e = M.el[k]; if (!e || e.id !== o.id) return;
      const roof = o.ty === 'IFCROOF' || e.pc === 'IFCROOF' || /^IFCROOF\|/.test(e.f), G = LG[roof ? nL : Math.min(e.lev, nL - 1)];
      const op = [], tr = [];
      o.parts.forEach(p => { (p.c && p.c[3] < 0.95 ? tr : op).push(p); });
      [[op, false], [tr, true]].forEach(([L, glass]) => {
        if (!L.length) return;
        let n = 0; L.forEach(p => { n += p.t.length; });
        const pos = new Float32Array(n), col = new Float32Array(n); let w = 0;
        L.forEach(p => { const c = lin(p.c || [0.8, 0.8, 0.8]), t = p.t; for (let i = 0; i < t.length; i += 3, w += 3) { pos[w] = t[i] - O[0]; pos[w + 1] = t[i + 2]; pos[w + 2] = -(t[i + 1] - O[1]); col[w] = c[0]; col[w + 1] = c[1]; col[w + 2] = c[2]; } });
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals();
        const m = addSolid(G, g, glass ? IM.nG : IM.n, null, { kind: KIND(o.ty), ifc: true, k, lev: e.lev, glass }, !glass);
        (ELM.get(k) || ELM.set(k, []).get(k)).push(m);
        if (!glass && n / 9 < 20000) edges(G, g, 0.3, 30);
      });
    });
    // locaux de la maquette (IfcSpace) : volumes invisibles, montrés quand on les choisit
    const sp = rt.G.spaces || new Map();
    P.rooms.forEach(r => {
      const parts = r.ifc != null ? sp.get(r.ifc) : null; if (!parts) return;
      let n = 0; parts.forEach(p => { n += p.t.length; }); const pos = new Float32Array(n); let w = 0;
      parts.forEach(p => { const t = p.t; for (let i = 0; i < t.length; i += 3, w += 3) { pos[w] = t[i] - O[0]; pos[w + 1] = t[i + 2] + 0.02; pos[w + 2] = -(t[i + 1] - O[1]); } });
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.computeVertexNormals();
      const f = r.f || (r.f = fonction(r.n, r.ext)), col = LC(FN[f] || '#bbb');
      const vm = cm(new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, emissive: col, emissiveIntensity: 0.1 }));
      const vol = new THREE.Mesh(g, vm); vol.visible = false; vol.renderOrder = 3; LG[Math.min(r.lev, nL - 1)].add(vol);
      const R = { r, lev: r.lev, floor: null, vol, vm, floorMat: new THREE.MeshBasicMaterial(), base: col, hv: 2.5, z: (P.levels[r.lev] || { z: 0 }).z };
      vol.userData = { kind: 'local', R }; ROOMS.push(R); PICK.push(vol);
    });
  }
  // mise en évidence d'ouvrages (indices du modèle) ; cadrer = la caméra vient sur eux
  function highlight(ks, frame) {
    S.ifcHi = ks && ks.size ? ks : null; applyLook();
    if (frame && S.ifcHi) {
      const b = new THREE.Box3(); S.ifcHi.forEach(k => (ELM.get(k) || []).forEach(m => { m.geometry.computeBoundingBox(); const bb = m.geometry.boundingBox.clone(); bb.translate(m.parent.position); b.union(bb); }));
      if (!b.isEmpty()) { const c = b.getCenter(new THREE.Vector3()), r = Math.max(4, b.getSize(new THREE.Vector3()).length()); const dir = cam.position.clone().sub(controls.target).normalize(); if (dir.y < 0.35) { dir.y = 0.5; dir.normalize(); } camTo(c.clone().add(dir.multiplyScalar(r * 1.3)), c); }
    }
  }
  // préau, auvent : couverture légère sur poutres et poteaux ; panneaux photovoltaïques par travée si les pièces écrites en parlent
  function auvent(RG, r, photo) {
    const o = r.o, z = r.z, steel = photo ? std(0x8d949b, { roughness: 0.45, metalness: 0.55 }) : npr(cm(new THREE.MeshLambertMaterial({ color: 0xffffff })));
    const { g } = roofGeo(r);
    addSolid(RG, g, steel, capMat(0x7a7d80), { kind: 'toiture', r }); edges(RG, g, 0.3, 20);
    // repère du rectangle : grand côté (d) et petit côté (e)
    let u = [o[1][0] - o[0][0], o[1][1] - o[0][1]], v = [o[3][0] - o[0][0], o[3][1] - o[0][1]], Lu = Math.hypot(...u), Lv = Math.hypot(...v), bu = (r.bays || [])[0] || 1, bv = (r.bays || [])[1] || 1;
    if (!Lu || !Lv) return;
    let d = [u[0] / Lu, u[1] / Lu], e = [v[0] / Lv, v[1] / Lv], Ld = Lu, Le = Lv, nb = bv;
    if (Lv > Lu) { d = [v[0] / Lv, v[1] / Lv]; e = [u[0] / Lu, u[1] / Lu]; Ld = Lv; Le = Lu; nb = bu; }
    const O = o[0], ang = Math.atan2(d[1], d[0]), at = (sd, se) => [O[0] + d[0] * sd + e[0] * se, O[1] + d[1] * sd + e[1] * se];
    // les côtés o[0]→o[1] et o[0]→o[3] ne partent pas forcément du même coin selon d/e : on se ramène au coin minimal
    const us = o.map(p => (p[0] - O[0]) * d[0] + (p[1] - O[1]) * d[1]), es = o.map(p => (p[0] - O[0]) * e[0] + (p[1] - O[1]) * e[1]);
    const d0 = Math.min(...us), e0 = Math.min(...es);
    // poutres sous la couverture, sur les files de poteaux (dans le sens long)
    const posts = P.cols.filter(c => c.auvent && c.lev === r.lev && inPoly2(c.c, o)), BM = [];
    const files = []; posts.forEach(c => { const se = (c.c[0] - O[0]) * e[0] + (c.c[1] - O[1]) * e[1], f = files.find(f => Math.abs(f.se - se) < 0.6); if (f) f.n++; else files.push({ se, n: 1 }); });
    files.filter(f => f.n >= 2).forEach(f => { const c = at(d0 + Ld / 2, f.se); BM.push({ len: Ld, thk: 0.18, y0: z - 0.5, y1: z - 0.2, ang, cx: c[0], cz: c[1] }); });
    const bg = boxesGeo(BM); if (bg) { addSolid(RG, bg, steel, null, { kind: 'toiture', r }); edges(RG, bg, 0.2, 30); }
    if (!r.pv) return;
    // panneaux : une bande par travée, modules 1,65 × 1,0 m, à 2 cm au-dessus de la couverture
    const PV = [], nbs = Math.max(1, nb), we = Le / nbs;
    for (let k = 0; k < nbs; k++) {
      const a0 = e0 + k * we + 0.45, a1 = e0 + (k + 1) * we - 0.45, nr = Math.max(1, Math.floor((a1 - a0 + 0.02) / 1.02)), nc = Math.max(1, Math.floor((Ld - 0.8 + 0.02) / 1.67));
      const sa = (a1 - a0 - nr * 1.02) / 2, sd = (Ld - nc * 1.67) / 2;
      for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) { const c = at(d0 + sd + j * 1.67 + 0.825, a0 + sa + i * 1.02 + 0.5); PV.push({ len: 1.65, thk: 1.0, y0: z + 0.02, y1: z + 0.06, ang, cx: c[0], cz: c[1] }); }
    }
    const pg = boxesGeo(PV); if (!pg) return;
    const pm = photo ? std(0x1b2740, { roughness: 0.22, metalness: 0.6, envMapIntensity: 1.5 }) : npr(cm(new THREE.MeshLambertMaterial({ color: 0x8796a8 })));
    const m = new THREE.Mesh(pg, pm); m.castShadow = photo; m.userData = { kind: 'toiture', r }; RG.add(m); PICK.push(m); edges(RG, pg, 0.35, 30);
  }
  function inPoly2(p, o) { let c = false; for (let i = 0, j = o.length - 1; i < o.length; j = i++) { const a = o[i], b = o[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
  function openingDims(o, H = 3) {
    const kind = o.kind || (o.ext ? 'fenetre' : 'porte');
    if (o.full) return { kind, sill: 0, h: Math.max(2.2, H - 0.3), full: true };
    if (kind === 'porte') return { kind, sill: 0, h: o.h && o.h > 1.8 ? o.h : 2.15 };
    if (o.sill != null && o.h) return { kind, sill: o.sill, h: o.h };                         // lu sur la façade
    if (o.h) return { kind, sill: o.h >= 2.0 ? 0 : Math.max(0.05, 2.25 - o.h), h: o.h };       // hauteur lue sur le plan
    if (kind === 'baie') return { kind, sill: 0, h: 2.25 };
    return { kind, sill: 0.9, h: 1.35 };                                                         // fenêtre courante (hypothèse)
  }

  // ------------------------------------------------------------------ apparence, éclaté, coupes
  function setOp(m, v) { if (!m) return; m.opacity = v; const tr = v < 0.999; if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; } m.depthWrite = !tr; }
  function applyLook() {
    const ghost = S.mode === 'translucide' || S.mode === 'fonction' || !!S.filter, wire = S.mode === 'filaire';
    if (P && P.source === 'ifc' && IM) { ifcLook(ghost, wire); return; }
    LG.forEach((G, i) => {
      const isRoof = i === P.levels.length;
      G.visible = isRoof ? S.roofs : true;
      const iso = S.iso != null && S.iso !== i && !isRoof;
      const xr = S.sel && S.sel.R && S.mode === 'plein' && !S.filter && S.iso == null && i > S.sel.R.lev;
      const f = wire ? 0 : (ghost || iso || xr) ? (isRoof && !wire ? 0.12 : 0.14) : 1;
      (G.userData.fills || []).forEach(m => { setOp(m.material, f); m.visible = f > 0.01; });
      (G.userData.caps || []).forEach(m => { m.visible = f > 0.9 && CLIP.length > 0; });
      G.children.forEach(c => { if (c.isLineSegments) { c.material.opacity = wire ? 0.9 : (ghost || iso || xr) ? 0.25 : (S.style === 'blanc' ? 0.42 : LIT() ? 0.22 : 0.75); c.visible = true; } });
    });
    ROOMS.forEach(R => {
      let op = 0, col = R.base;
      if (S.mode === 'fonction') op = 0.8;
      if (S.filter) op = S.filter.has(R.r.id) ? 0.85 : 0;
      if (S.sel && S.sel.R === R) { op = 0.65; col = LC(0x2f6fd6); }
      if (S.hover && S.hover.R === R && op < 0.3) op = 0.3;
      if (S.iso != null && S.iso !== R.lev) op = 0;
      R.vm.opacity = op; R.vm.color.copy(col); R.vm.emissive.copy(col); R.vol.visible = op > 0.01;
      const xr = S.sel && S.sel.R && R.lev > S.sel.R.lev && S.iso == null;
      setOp(R.floorMat, (S.iso != null && S.iso !== R.lev) || xr ? 0.1 : 1);
    });
  }
  function ifcLook(ghost, wire) {
    const hi = S.ifcHi, selK = S.sel && S.sel.u && S.sel.u.ifc ? S.sel.u.k : null, nL = P.levels.length;
    LG.forEach((G, i) => {
      const isRoof = i === nL; G.visible = isRoof ? S.roofs : true;
      const iso = S.iso != null && S.iso !== i && !isRoof;
      const xr = S.sel && S.sel.R && S.mode === 'plein' && !S.filter && S.iso == null && i > S.sel.R.lev;
      (G.userData.fills || []).forEach(m => {
        const u = m.userData, gl = u.glass;
        let st = (ghost || iso || xr) ? 'g' : 'n';
        if (hi) st = hi.has(u.k) ? 'h' : 'g';
        if (selK === u.k) st = 's';
        m.material = st === 'h' ? IM.h : st === 's' ? IM.s : st === 'g' ? (gl ? IM.gG : IM.g) : (gl ? IM.nG : IM.n);
        m.visible = !wire; m.castShadow = LIT() && st === 'n' && !gl;
      });
      G.children.forEach(c => { if (c.isLineSegments) { c.material.opacity = wire ? 0.9 : (ghost || iso || xr || hi) ? 0.12 : (S.style === 'blanc' ? 0.42 : LIT() ? 0.22 : 0.75); c.visible = true; } });
    });
    ROOMS.forEach(R => {
      let op = 0, col = R.base;
      if (S.mode === 'fonction') op = 0.8;
      if (S.filter) op = S.filter.has(R.r.id) ? 0.85 : 0;
      if (S.sel && S.sel.R === R) { op = 0.65; col = LC(0x2f6fd6); }
      if (S.hover && S.hover.R === R && op < 0.3) op = 0.3;
      if (S.iso != null && S.iso !== R.lev) op = 0;
      R.vm.opacity = op; R.vm.color.copy(col); R.vm.emissive.copy(col); R.vol.visible = op > 0.01;
    });
  }
  function placeLevels() { LG.forEach((G, i) => { G.position.y = S.explode * i * 6; }); }
  function setCuts(cuts) {
    CLIP.length = 0;
    cuts.forEach(c => { if (!c.on) return; const n = c.axe === 'x' ? new THREE.Vector3(-1, 0, 0) : c.axe === 'z' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, -1, 0); if (c.flip) n.negate(); CLIP.push(new THREE.Plane(n, c.flip ? -c.v : c.v)); });
    clipMats.forEach(m => { m.needsUpdate = true; }); applyLook();
  }

  // ------------------------------------------------------------------ caméra
  let tw = null;
  function camTo(pos, tgt, dur = 900) { const p0 = cam.position.clone(), t0 = controls.target.clone(), s = performance.now(); tw = k => { const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; cam.position.lerpVectors(p0, pos, e); controls.target.lerpVectors(t0, tgt, e); }; tw.s = s; tw.d = dur; }
  function view(kind) {
    const span = Math.max(B.x1 - B.x0, B.y1 - B.y0) || 40, t = new THREE.Vector3(CX, 2, CZ);
    const V = { iso: [-0.7, 0.62, 0.9], dessus: [0.001, 1, 0.01], sud: [0.1, 0.25, 1], nord: [-0.1, 0.25, -1], est: [1, 0.25, 0.1], ouest: [-1, 0.25, -0.1] }[kind] || [-0.7, 0.62, 0.9];
    const d = new THREE.Vector3(...V).normalize().multiplyScalar(span * 1.45);
    if (S.proj === 'axo' && kind === 'iso') d.set(-1, 0.8165, 1).normalize().multiplyScalar(span * 1.45);   // axonométrie isométrique (35,26°)
    camTo(t.clone().add(d), t);
  }
  function setProj(p) {
    S.proj = p; const prev = cam;
    cam = p === 'axo' ? camO : camP; cam.position.copy(prev.position); controls.object = cam; controls.update(); fitOrtho(); view('iso');
  }
  function focusRoom(id) { const R = ROOMS.find(x => x.r.id === id); if (!R) return; const c = PROJ.centroid(R.r.polys[0]), t = new THREE.Vector3(c[0], R.z + LG[R.lev].position.y + 1, c[1]); const dir = cam.position.clone().sub(controls.target).normalize(); if (dir.y < 0.45) { dir.y = 0.6; dir.normalize(); } camTo(t.clone().add(dir.multiplyScalar(Math.max(18, Math.sqrt(R.r.am) * 3.5))), t); }

  // ------------------------------------------------------------------ animation de construction
  const PHASES = [
    { t: 'Terrassement, dallage et fondations', lot: 'Gros-œuvre', k: o => o.kind === 'dalle' && o.lev === 0 },
    { t: 'Murs et poteaux du rez-de-chaussée', lot: 'Gros-œuvre · ossature bois', k: o => (o.kind === 'mur' || o.kind === 'poteau' || o.kind === 'linteaux') && o.lev === 0 },
    { t: 'Planchers et murs des étages', lot: 'Gros-œuvre · structure', k: o => (o.kind === 'dalle' || o.kind === 'mur' || o.kind === 'poteau' || o.kind === 'linteaux') && o.lev > 0 },
    { t: 'Escaliers', lot: 'Gros-œuvre · serrurerie', k: o => o.kind === 'escalier' },
    { t: 'Couverture et étanchéité', lot: 'Couverture · étanchéité', k: o => o.kind === 'toiture' },
    { t: 'Menuiseries extérieures', lot: 'Menuiseries extérieures', k: o => o.kind === 'baie' },
    { t: 'Aménagement intérieur', lot: 'Plâtrerie · revêtements · peintures', k: o => o.kind === 'local' || o.kind === 'equip' }
  ];
  function animate(onPhase) {
    const objs = []; ROOT.traverse(o => { if (o.isMesh && o.userData && o.userData.kind) objs.push(o); });
    objs.forEach(o => { o.userData._vis = o.visible; o.visible = false; });
    let ph = 0; const per = 2600;
    S.anim = { t0: performance.now(), step: () => {
      const k = Math.floor((performance.now() - S.anim.t0) / per);
      if (k !== ph || k === 0 && !S.anim.started) {
        S.anim.started = true; ph = k;
        if (ph >= PHASES.length) { objs.forEach(o => { o.visible = o.userData._vis; o.scale.y = 1; }); S.anim = null; onPhase && onPhase(null); applyLook(); return; }
        onPhase && onPhase(PHASES[ph], ph);
      }
      const f = ((performance.now() - S.anim.t0) % per) / per, e = 1 - Math.pow(1 - Math.min(1, f * 1.6), 3);
      objs.forEach(o => { const u = o.userData; for (let q = 0; q <= Math.min(ph, PHASES.length - 1); q++) if (PHASES[q].k(Object.assign({ lev: u.R ? u.R.lev : (u.lev ?? (u.c ? 0 : 0)) }, u))) { o.visible = u._vis !== false || u.kind === 'local' ? (u.kind === 'local' ? true : true) : false; if (u.kind === 'local') { u.R.vm.opacity = q === ph ? 0.6 * e : 0.35; o.visible = true; } o.scale.y = q === ph && u.kind !== 'local' ? Math.max(0.001, e) : 1; } });
      controls.autoRotate = true; controls.autoRotateSpeed = 0.9;
    } };
  }
  function stopAnim() { if (S.anim) { S.anim = null; controls.autoRotate = false; build(); } }

  // ------------------------------------------------------------------ sélection
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  function pickAt(ev) {
    const r = renderer.domElement.getBoundingClientRect(); mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, cam);
    const hits = ray.intersectObjects(PICK, false), solid = S.mode === 'plein' && !S.filter;
    for (const h of hits) {
      const u = h.object.userData; if (!u || !u.kind) continue;
      if (CLIP.some(pl => pl.distanceToPoint(h.point) < -0.01)) continue;
      if (u.kind === 'local') { const R = u.R; if (S.iso != null && S.iso !== R.lev) continue; if (S.filter && !S.filter.has(R.r.id)) continue; return { kind: 'local', R, point: h.point }; }
      let o = h.object, vis = true; while (o) { if (!o.visible) vis = false; o = o.parent; } if (!vis) continue;
      if (h.object.material.opacity < 0.5) continue;
      if (!solid && ['mur', 'toiture', 'dalle', 'linteaux'].includes(u.kind)) continue;
      return { kind: u.kind, u, point: h.point };
    }
    return null;
  }
  function pickEvents() {
    let down = null;
    renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener('pointerup', e => { if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || e.button !== 0) return; const p = pickAt(e); S.sel = p; applyLook(); S.onPick && S.onPick(p); });
    let t = 0; renderer.domElement.addEventListener('pointermove', e => { const n = performance.now(); if (n - t < 50) return; t = n; const p = pickAt(e); const k = p ? (p.R || p.u) : null, k0 = S.hover ? (S.hover.R || S.hover.u) : null; if (k !== k0) { S.hover = p; applyLook(); } S.onHover && S.onHover(p, e); renderer.domElement.style.cursor = p ? 'pointer' : ''; });
  }
  function loop(now) {
    requestAnimationFrame(loop);
    if (!renderer) return;
    if (tw) { const k = Math.min(1, (now - tw.s) / tw.d); tw(k); if (k >= 1) tw = null; }
    if (S.anim) S.anim.step();
    controls.update();
    if (composer && LIT() && !S.noAO) { rpass.camera = cam; gtao.camera = cam; composer.render(); } else renderer.render(scene, cam);
  }
  function snapshot() { if (composer && LIT() && !S.noAO) composer.render(); else renderer.render(scene, cam); return renderer.domElement.toDataURL('image/png'); }
  return { init, resize, attachTo, build, highlight, view, setProj, setCuts, applyLook, placeLevels, focusRoom, animate, stopAnim, snapshot, S, FN, FNL, fonction, get ROOMS() { return ROOMS; }, get bounds() { return B; }, openingDims, get controls() { return controls; }, get camera() { return cam; }, get renderer() { return renderer; }, elems: k => ELM.get(k) || [] };
})();

/* ---- m8_analyse.js ---- */
/* ==================================================================================================
   DCE Educ — m8_analyse : étude de DCE pour une réponse à appel d'offres (élèves Bac Pro / BTS)
   métré comparé au DPGF, fiches par lot, incohérences → questions, exports HTML et CSV
   ================================================================================================== */
'use strict';
const ANA = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n2 = v => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  const lotLabel = (P, n) => { const c = P.cctp.find(x => x.lot === n), d = P.dpgf.find(x => x.lot === n); return 'Lot ' + n + (((c && c.titre) || (d && d.titre)) ? ' — ' + ((c && c.titre) || d.titre) : ''); };
  const lots = P => [...new Set(P.cctp.map(c => c.lot).concat(P.dpgf.map(d => d.lot)))].sort();

  // ------------------------------------------------------------------ 1. métré comparé au DPGF
  function metre(P, lot) {
    const D = P.dpgf.filter(d => !lot || d.lot === lot);
    if (!D.length) return `<p class="muted">Aucun DPGF déposé${lot ? ' pour ce lot' : ''}. Ajoutez les DPGF (PDF) dans l'onglet Dossier pour comparer les quantités.</p>`;
    let h = '';
    D.forEach(d => {
      const rows = d.lignes.filter(l => l.u || l.q != null);
      const cmp = rows.filter(l => l.est);
      h += `<section class="an-lot"><h3>${esc(lotLabel(P, d.lot))} <span class="muted small">${rows.length} lignes chiffrables · ${cmp.length} comparées à la maquette</span></h3>
      <div class="tbl"><table class="metre"><thead><tr><th>Art.</th><th>Désignation</th><th>U</th><th class="n">Q DPGF</th><th class="n">Q maquette</th><th class="n">Écart</th><th>Comment c'est mesuré</th></tr></thead><tbody>`;
      rows.forEach(l => {
        const e = l.est && l.q ? (l.q / l.est.q - 1) : null;
        const cls = e == null ? '' : Math.abs(e) <= 0.1 ? 'ok' : Math.abs(e) <= 0.25 ? 'mid' : 'bad';
        h += `<tr data-rooms="${l.est ? l.est.rooms.join(',') : ''}"${l.est && l.est.fams ? ` data-fams="${esc(l.est.fams.join('|'))}"` : ''} class="${l.est && (l.est.rooms.length || l.est.fams) ? 'clic' : ''}"><td>${esc(l.num)}</td><td>${esc(l.des)}${l.art ? '' : (l.num ? ' <span class="pill bad" title="Pas d\'article de même numéro au CCTP">sans article</span>' : '')}</td><td>${esc(l.u || '')}</td>
          <td class="n">${n2(l.q)}${l.decale ? ' <span class="muted" title="valeur lue sur la ligne suivante du PDF">↵</span>' : ''}</td><td class="n">${l.est ? n2(l.est.q) : '<span class="muted">—</span>'}</td>
          <td class="n">${e == null ? '' : `<span class="pill ${cls}">${e > 0 ? '+' : ''}${Math.round(e * 100)} %</span>`}</td><td class="small">${l.est ? esc(l.est.how) : `<span class="muted">${esc(l.estNote || 'pas de règle de mesure pour cet ouvrage')}</span>`}</td></tr>`;
      });
      h += '</tbody></table></div></section>';
    });
    return h;
  }
  // ------------------------------------------------------------------ 2. fiche par lot
  function fiche(P, n) {
    const c = P.cctp.find(x => x.lot === n), d = P.dpgf.find(x => x.lot === n);
    let h = `<section class="an-lot"><h3>${esc(lotLabel(P, n))}</h3><div class="kpis">
      <div><small>Articles CCTP</small><b>${c ? c.articles.length : '—'}</b></div><div><small>Lignes DPGF</small><b>${d ? d.lignes.length : '—'}</b></div>
      <div><small>Locaux cités</small><b>${c ? new Set(c.articles.flatMap(a => a.rooms || [])).size : '—'}</b></div><div><small>Références</small><b>${c ? new Set(c.articles.flatMap(a => a.refs.map(r => r.v))).size : '—'}</b></div></div>`;
    if (c) {
      const refs = new Map(); c.articles.forEach(a => a.refs.forEach(r => { if (!refs.has(r.v)) refs.set(r.v, { k: r.k, a: [] }); refs.get(r.v).a.push(a.num); }));
      if (refs.size) { h += '<h4>Normes, DTU et classements exigés</h4><div class="chips">'; [...refs].sort((a, b) => a[1].k.localeCompare(b[1].k)).forEach(([v, x]) => { h += `<span class="chip" title="${esc(x.k)} — art. ${esc(x.a.join(', '))}"><b>${esc(v)}</b><span class="muted small">${esc(x.k)}</span></span>`; }); h += '</div>'; }
      const loc = c.articles.filter(a => a.loc && a.feuille);
      if (loc.length) { h += '<h4>Ouvrages et localisations</h4><div class="tbl"><table><thead><tr><th>Art.</th><th>Ouvrage</th><th>Localisation (CCTP)</th><th>Locaux reconnus</th></tr></thead><tbody>'; loc.forEach(a => { const R = (a.rooms || []).map(id => P.rooms.find(r => r.id === id)).filter(Boolean); h += `<tr data-rooms="${R.map(r => r.id).join(',')}" class="${R.length ? 'clic' : ''}"><td>${esc(a.num)}</td><td>${esc(a.titre)}</td><td class="small">${esc(a.loc.slice(0, 260))}</td><td class="small">${a.tous ? '<i>tous les locaux</i>' : R.length ? R.map(r => esc(r.n)).join(', ') : '<span class="muted">—</span>'}</td></tr>`; }); h += '</tbody></table></div>'; }
    }
    const Iss = (P.issues || []).filter(i => i.lot === n);
    if (Iss.length) { h += `<h4>Points à éclaircir (${Iss.length})</h4><ul class="doc">` + Iss.map(i => `<li>${esc(i.t)}</li>`).join('') + '</ul>'; }
    return h + '</section>';
  }
  // ------------------------------------------------------------------ 3. incohérences et questions
  const NIV = { q: ['Question', 'mid'], ecart: ['Écart de quantité', 'bad'], info: ['À vérifier', 'man'] };
  function questions(P, sel) {
    const I = P.issues || [];
    if (!I.length) return '<p class="muted">Aucune incohérence détectée automatiquement. Relisez quand même les pièces : l\'outil ne voit que ce qu\'il sait comparer.</p>';
    let h = `<p class="small muted">${I.length} points relevés automatiquement. Cochez ceux à envoyer au maître d'œuvre, reformulez si besoin : la liste cochée part dans l'export.</p><div class="qlist">`;
    I.forEach((i, k) => { const nv = NIV[i.niv] || NIV.info; h += `<div class="qitem"><label class="qchk"><input type="checkbox" data-q="${k}" ${sel.has(k) ? 'checked' : ''}><span class="pill ${nv[1]}">${nv[0]}</span> <span class="small muted">${esc(i.lot === '—' ? 'Tous lots' : 'Lot ' + i.lot)}${i.art ? ' · art. ' + esc(i.art) : ''}</span></label><div class="small">${esc(i.t)}</div><textarea data-qt="${k}" rows="2">${esc(i.qEdit || i.q)}</textarea></div>`; });
    return h + '</div>';
  }
  // ------------------------------------------------------------------ 4. exports
  function reportHTML(P, sel) {
    const css = 'body{font:12px/1.45 Arial,sans-serif;color:#111;margin:24px}h1{font-size:20px}h2{font-size:16px;border-bottom:2px solid #b4462f;padding-bottom:3px;margin-top:26px}h3{font-size:14px}table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border:1px solid #bbb;padding:3px 5px;vertical-align:top}th{background:#eee}.n{text-align:right}.pill{font-size:10px;border-radius:8px;padding:0 5px}.ok{background:#dcebdc}.mid{background:#f6e3c4}.bad{background:#f4d3cc}.man{background:#e1e8f5}.muted{color:#777}.small{font-size:11px}.kpis{display:flex;gap:10px}.kpis div{border:1px solid #ccc;padding:4px 8px}.chips span{display:inline-block;border:1px solid #ccc;border-radius:10px;padding:1px 7px;margin:2px}ol li{margin:5px 0}';
    const Q = (P.issues || []).map((i, k) => [i, k]).filter(([i, k]) => sel.has(k));
    let h = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Étude de DCE — ${esc(P.nom)}</title><style>${css}</style><body>
      <h1>Étude de DCE — ${esc(P.nom)}</h1><p class="muted">Dossier analysé avec DCE Educ le ${new Date().toLocaleDateString('fr-FR')} · ${P.pieces.length} pièces déposées, ${P.levels.length} niveaux, ${P.rooms.length} locaux, ${P.cctp.length} CCTP, ${P.dpgf.length} DPGF.</p>
      <h2>1. Questions au maître d'œuvre (${Q.length})</h2><ol>${Q.map(([i, k]) => `<li><b>${esc(i.lot === '—' ? 'Tous lots' : 'Lot ' + i.lot)}${i.art ? ', art. ' + esc(i.art) : ''}</b> — ${esc(i.qEdit || i.q)}</li>`).join('') || '<li class="muted">aucune question cochée</li>'}</ol>
      <h2>2. Niveaux et surfaces</h2><table><tr><th>Niveau</th><th class="n">Altitude</th><th class="n">Hauteur</th><th class="n">Locaux</th><th class="n">Surface DCE (m²)</th></tr>${P.levels.map((L, i) => { const R = P.rooms.filter(r => r.lev === i && !r.ext); return `<tr><td>${esc(L.nom)}</td><td class="n">${n2(L.z)}</td><td class="n">${n2(L.h)}</td><td class="n">${R.length}</td><td class="n">${n2(R.reduce((s, r) => s + (r.a || r.am), 0))}</td></tr>`; }).join('')}</table>
      <h2>3. Métré comparé au DPGF</h2>${metre(P)}
      <h2>4. Fiches par lot</h2>${lots(P).map(n => fiche(P, n)).join('')}</body></html>`;
    return h.replace(/ data-rooms="[^"]*"| class="clic"/g, '');
  }
  function csv(P) {
    const rows = [['Lot', 'Article', 'Désignation', 'Unité', 'Quantité DPGF', 'Quantité maquette', 'Écart %', 'Méthode de mesure']];
    P.dpgf.forEach(d => d.lignes.forEach(l => { const e = l.est && l.q ? Math.round((l.q / l.est.q - 1) * 100) : ''; rows.push([d.lot, l.num, l.des, l.u || '', l.q ?? '', l.est ? l.est.q : '', e, l.est ? l.est.how : '']); }));
    return '﻿' + rows.map(r => r.map(v => { const s = String(v).replace(/\./g, typeof v === 'number' ? ',' : '.'); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
  }
  return { metre, fiche, questions, reportHTML, csv, lots, lotLabel };
})();

/* ---- m11_visionneuse.js ---- */
/* ==================================================================================================
   DCE Educ — m11_visionneuse : les pièces graphiques du DCE affichées TELLES QU'ELLES SONT FOURNIES.
   Rendu PDFium de la feuille (traits, textes, images, annotations), sans lecture, sans retouche :
   une image de toute la feuille pour la vue d'ensemble, puis un rendu net de la partie visible
   à chaque arrêt du zoom ou du déplacement.
   ================================================================================================== */
'use strict';
const VIS = (() => {
  const PT = 96 / 72;                                  // 100 % = taille réelle de la feuille (1 pt = 1/72 pouce)
  let host = null, cv = null, ctx = null, ui = {};
  let cur = null;          // { src, doc, own, n, no, page, W, H }
  let V = null;            // vue : coin haut-gauche (x, y en points de la feuille) et k (pixels CSS par point)
  let base = null, det = null, timer = 0, token = 0, fitK = 1;
  const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const idle = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));   // laisse l'écran se peindre avant un long rendu

  function attach(el) {
    host = el;
    host.innerHTML = `<canvas aria-label="Feuille du dossier"></canvas>
      <div class="vbar float"><button class="ibtn" data-vz="-" title="Zoom arrière (−)">−</button><span class="vpct" title="100 % = taille réelle de la feuille">—</span><button class="ibtn" data-vz="+" title="Zoom avant (+)">+</button><button class="ibtn" data-vz="fit" title="Feuille entière (0)">Ajuster</button><button class="ibtn" data-vz="1" title="Taille réelle de la feuille">100 %</button>
        <span class="vsep"></span><button class="ibtn" data-vp="-1" title="Page précédente">‹</button><span class="vpage">—</span><button class="ibtn" data-vp="1" title="Page suivante">›</button></div>
      <div class="vinfo float"></div><div class="vwait">Préparation de la feuille…</div>`;
    cv = host.querySelector('canvas'); ctx = cv.getContext('2d');
    ui = { pct: host.querySelector('.vpct'), page: host.querySelector('.vpage'), info: host.querySelector('.vinfo'), wait: host.querySelector('.vwait') };
    host.querySelectorAll('[data-vz]').forEach(b => b.onclick = () => { const z = b.dataset.vz; if (z === 'fit') fit(); else if (z === '1') zoomAt(PT, cv.clientWidth / 2, cv.clientHeight / 2, true); else zoomBy(z === '+' ? 1.5 : 1 / 1.5); });
    host.querySelectorAll('[data-vp]').forEach(b => b.onclick = () => { if (cur) goPage(cur.no + +b.dataset.vp); });
    cv.onwheel = e => { e.preventDefault(); if (!V) return; const r = cv.getBoundingClientRect(); zoomAt(V.k * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0016)), e.clientX - r.left, e.clientY - r.top); };
    let drag = null;
    cv.onpointerdown = e => { if (!V) return; drag = { x: e.clientX, y: e.clientY, vx: V.x, vy: V.y }; cv.setPointerCapture(e.pointerId); cv.classList.add('grab'); };
    cv.onpointermove = e => { if (!drag) return; V.x = drag.vx - (e.clientX - drag.x) / V.k; V.y = drag.vy - (e.clientY - drag.y) / V.k; draw(); later(); };
    cv.onpointerup = cv.onpointercancel = () => { drag = null; cv.classList.remove('grab'); };
    cv.ondblclick = e => { if (!V) return; const r = cv.getBoundingClientRect(); zoomAt(V.k * 2, e.clientX - r.left, e.clientY - r.top); };
    host.tabIndex = 0;
    host.onkeydown = e => { if (!V) return; if (e.key === '+' || e.key === '=') zoomBy(1.5); else if (e.key === '-') zoomBy(1 / 1.5); else if (e.key === '0') fit(); else if (e.key === 'PageDown') goPage(cur.no + 1); else if (e.key === 'PageUp') goPage(cur.no - 1); else return; e.preventDefault(); };
    new ResizeObserver(() => resize()).observe(host);
    resize();
  }
  function resize() {
    if (!cv) return;
    const w = Math.max(10, host.clientWidth), h = Math.max(10, host.clientHeight), d = DPR();
    const ow = cv.clientWidth || w, oh = cv.clientHeight || h;
    cv.width = Math.round(w * d); cv.height = Math.round(h * d); cv.style.width = w + 'px'; cv.style.height = h + 'px';
    if (V && cur) { // garde le centre de la vue
      const cx = V.x + ow / 2 / V.k, cy = V.y + oh / 2 / V.k; fitK = Math.min(w / cur.W, h / cur.H) * 0.96; V.x = cx - w / 2 / V.k; V.y = cy - h / 2 / V.k;
    }
    draw(); later();
  }
  function fit() {
    if (!cur) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    fitK = Math.min(w / cur.W, h / cur.H) * 0.96;
    V = { k: fitK, x: cur.W / 2 - w / 2 / fitK, y: cur.H / 2 - h / 2 / fitK };
    draw(); later();
  }
  function zoomAt(k, px, py, center) {
    if (!V) return;
    k = Math.max(fitK * 0.5, Math.min(k, PT * 24));
    const X = V.x + px / V.k, Y = V.y + py / V.k;
    V.k = k;
    if (center) { V.x = X - cv.clientWidth / 2 / k; V.y = Y - cv.clientHeight / 2 / k; } else { V.x = X - px / k; V.y = Y - py / k; }
    draw(); later();
  }
  const zoomBy = f => V && zoomAt(V.k * f, cv.clientWidth / 2, cv.clientHeight / 2);

  // ---------------------------------------------------------------- dessin à l'écran (aucun rendu PDFium ici)
  function draw() {
    if (!ctx) return;
    const d = DPR();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(host).getPropertyValue('--vfond') || '#7d8287'; ctx.fillRect(0, 0, cv.width, cv.height);
    if (!cur || !V) return;
    const s = d * V.k, ox = -V.x * s, oy = -V.y * s;
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(ox + 3 * d, oy + 3 * d, cur.W * s, cur.H * s);
    ctx.fillStyle = '#fff'; ctx.fillRect(ox, oy, cur.W * s, cur.H * s);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (base) ctx.drawImage(base.c, ox, oy, cur.W * s, cur.H * s);
    if (det && det.no === cur.no) ctx.drawImage(det.c, (det.x - V.x) * s, (det.y - V.y) * s, det.c.width * s / det.k, det.c.height * s / det.k);
    ui.pct.textContent = Math.round(V.k / PT * 100) + ' %';
  }
  function later(ms = 200) { clearTimeout(timer); timer = setTimeout(sharpen, ms); }

  // ---------------------------------------------------------------- rendus PDFium
  function bitmap(x0, y0, wpt, hpt, outW, outH) {
    const px = cur.page.view(x0, y0, wpt, hpt, outW, outH);
    const c = document.createElement('canvas'); c.width = outW; c.height = outH;
    c.getContext('2d').putImageData(new ImageData(px, outW, outH), 0, 0);
    return c;
  }
  async function sharpen() {
    if (!cur || !V || !base || !cur.page) return;
    const d = DPR(), s = d * V.k;
    if (s <= base.k * 1.08) { if (det) { det = null; draw(); } return; }
    const x0 = Math.max(0, V.x), y0 = Math.max(0, V.y), x1 = Math.min(cur.W, V.x + cv.clientWidth / V.k), y1 = Math.min(cur.H, V.y + cv.clientHeight / V.k);
    if (x1 <= x0 || y1 <= y0) return;
    if (det && det.no === cur.no && Math.abs(det.k - s) < 1e-6 && det.x <= x0 + 1e-3 && det.y <= y0 + 1e-3 && det.x + det.c.width / det.k >= x1 - 1e-3 && det.y + det.c.height / det.k >= y1 - 1e-3) return;
    const outW = Math.min(8000, Math.ceil((x1 - x0) * s)), outH = Math.min(8000, Math.ceil((y1 - y0) * s));
    const my = ++token, no = cur.no;
    host.classList.add('busy');
    await idle(); if (my !== token || !cur || cur.no !== no) return;
    try { det = { c: bitmap(x0, y0, outW / s, outH / s, outW, outH), x: x0, y: y0, k: s, no }; }
    catch (e) { console.warn(e); }
    host.classList.remove('busy');
    draw();
  }
  async function renderBase() {
    const d = DPR(), w = cv.clientWidth, h = cv.clientHeight;
    const kb = Math.min(Math.min(w / cur.W, h / cur.H) * d * 1.6, 4096 / Math.max(cur.W, cur.H));
    const outW = Math.max(1, Math.round(cur.W * kb)), outH = Math.max(1, Math.round(cur.H * kb));
    base = { c: bitmap(0, 0, cur.W, cur.H, outW, outH), k: outW / cur.W };
  }

  // ---------------------------------------------------------------- ouverture d'une pièce, d'une page
  // src : { key, nom, info, open: async () => ({ doc, own }) } — own : la visionneuse ferme le document en partant
  async function show(src, no = 1) {
    if (!host) return;
    if (cur && cur.src.key === src.key) { if (no !== cur.no) await goPage(no); return; }
    const my = ++token;
    ui.wait.textContent = 'Ouverture de « ' + src.nom + ' »…'; host.classList.add('loading');
    await idle();
    let D;
    try { D = await src.open(); } catch (e) { host.classList.remove('loading'); ui.info.innerHTML = '<b>Pièce illisible</b> : ' + esc(e.message); return; }
    if (my !== token) { if (D.own) D.doc.close(); return; }
    close();
    cur = { src, doc: D.doc, own: D.own, n: D.doc.numPages, no: 0, page: null };
    await goPage(no);
  }
  async function goPage(no) {
    if (!cur) return;
    no = Math.max(1, Math.min(cur.n, no)); if (no === cur.no && base) return;
    const my = ++token;
    if (cur.page) { cur.page.release(); cur.page = null; }
    base = null; det = null;
    ui.wait.textContent = 'Préparation de la feuille ' + no + ' / ' + cur.n + '…'; host.classList.add('loading');
    draw(); await idle(); if (my !== token) return;
    try {
      cur.page = await cur.doc.getPage(no); cur.no = no; cur.W = cur.page.W; cur.H = cur.page.H;
      fitK = Math.min(cv.clientWidth / cur.W, cv.clientHeight / cur.H) * 0.96;
      V = { k: fitK, x: cur.W / 2 - cv.clientWidth / 2 / fitK, y: cur.H / 2 - cv.clientHeight / 2 / fitK };
      await renderBase();
    } catch (e) { ui.info.innerHTML = '<b>Feuille illisible</b> : ' + esc(e.message); }
    host.classList.remove('loading');
    const mm = v => Math.round(v * 25.4 / 72);
    ui.page.textContent = cur.no + ' / ' + cur.n;
    ui.info.innerHTML = `<b>${esc(cur.src.nom)}</b><span>${cur.src.info ? esc(cur.src.info) + ' · ' : ''}feuille ${mm(cur.W)} × ${mm(cur.H)} mm</span>`;
    host.querySelectorAll('[data-vp]').forEach(b => b.disabled = cur.n < 2);
    draw(); later(50);
  }
  function close() {
    clearTimeout(timer); token++;
    if (cur) { if (cur.page) cur.page.release(); if (cur.own) try { cur.doc.close(); } catch (e) { } }
    cur = null; V = null; base = null; det = null;
    if (ui.info) { ui.info.innerHTML = ''; ui.page.textContent = '—'; ui.pct.textContent = '—'; }
    draw();
  }
  // en quittant l'onglet : la page est libérée dans PDFium (l'image de la feuille reste), rechargée au besoin
  function sleep() { if (cur && cur.page) cur.page.release(); }
  return { attach, show, close, sleep, fit, get key() { return cur ? cur.src.key : null; }, get page() { return cur ? cur.no : 0; } };
})();

/* ---- m9_ui.js ---- */
/* ==================================================================================================
   DCE Educ — m9_ui : interface (onglets, dépôt des pièces, assemblage, outils 3D, inspecteur,
   plans et coupes, pièces écrites, analyse de DCE, enregistrement)
   ================================================================================================== */
'use strict';
const APP = (() => {
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f2 = v => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n2 = v => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  let PIECES = [], P = null, built3d = false;
  const qsel = new Set();
  const KINDS = { plan: 'Plan de niveau', coupe: 'Coupe', facade: 'Façade', vue: 'Axonométrie / perspective', masse: 'Plan masse / situation', annexe: 'Plan d’annexe', pic: 'Installation de chantier', cctp: 'CCTP', dpgf: 'DPGF', autre: 'Autre pièce (non lue)' };
  const FIDL = { bon: ['Relevé, écart ≤ 15 %', 'ok'], moyen: ['Relevé, écart 15-30 %', 'mid'], faible: ['Relevé, écart > 30 %', 'bad'], deduit: ['Sans surface au plan', 'man'], manuel: ['Tracé à la main', 'man'] };

  // ------------------------------------------------------------------ onglets
  function show(v) {
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    $$('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
    if (v !== 'plans') VIS.sleep();
    // une seule vue 3D : elle passe de l'onglet Maquette 3D à l'onglet Associations
    if (v === '3d') V3.attachTo($('#v3host')); if (v === 'assoc') V3.attachTo($('#assocHost'));
    if (v !== 'assoc' && V3.S.ifcHi && AS_.fromAssoc) { AS_.fromAssoc = false; V3.highlight(null); }
    if (v === 'plans') renderViewer(); if (v === 'ecrits') renderEcrits(); if (v === 'analyse') renderAnalyse();
    if ((v === '3d' || v === 'assoc') && P && !built3d) { V3.build(P); built3d = true; V3.view('iso'); }
    if (v === 'assoc') renderAssoc();
    try { localStorage.setItem('dce-tab', v); } catch (e) { }
  }
  $$('#tabs button').forEach(b => b.onclick = () => show(b.dataset.v));

  // ------------------------------------------------------------------ dépôt des pièces
  const drop = $('#drop'), inp = $('#files');
  drop.onclick = () => inp.click(); drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') inp.click(); };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); };
  let addingSig = '';
  inp.addEventListener('change', () => { const sig = [...inp.files].map(f => f.name + f.size).join('|'); if (sig === addingSig) return; addingSig = sig; addFiles([...inp.files]); });
  function log(m, frac) { const L = $('#log'); L.textContent = (L.textContent === 'En attente des pièces.' ? '' : L.textContent + '\n') + m; L.scrollTop = 1e9; if (frac != null) $('#prog').style.width = Math.round(frac * 100) + '%'; }
  // la maquette numérique IFC du projet (une seule) : demandée au maître d'œuvre, elle fait la 3D
  let IFCFILE = null;
  async function addFiles(files) {
    const ifcs = files.filter(f => /\.ifc$/i.test(f.name)), pdfs = files.filter(f => /\.pdf$/i.test(f.name));
    if (ifcs.length) {
      IFCFILE = ifcs[ifcs.length - 1];
      log('Maquette IFC : ' + IFCFILE.name + ' (' + (IFCFILE.size / 1e6).toFixed(1).replace('.', ',') + ' Mo)', pdfs.length ? null : 1);
      // projet déjà lu avec cette maquette (ouvert depuis un fichier .json) : on recharge seulement sa géométrie
      if (P && P.source === 'ifc' && P.ifc && P.ifc.nom === IFCFILE.name && !(IFCX.RT && IFCX.RT.nom === P.ifc.nom)) await loadIfcGeometry(IFCFILE);
    }
    if (!pdfs.length) { if (!ifcs.length) log('Ni maquette IFC ni PDF dans la sélection.'); renderPieces(); return; }
    for (let i = 0; i < pdfs.length; i++) {
      const f = pdfs[i];
      if (PIECES.some(p => p.file.name === f.name && p.file.size === f.size)) continue;
      log('Classement : ' + f.name, i / pdfs.length);
      try {
        const doc = await PDFX.open(f), page = await doc.getPage(1), t = await PDFX.pageText(page);
        const cls = PDFX.classifyPiece(f.name, t, doc.numPages);   // contenu + indices du nom de fichier
        if (page.release) page.release();                        // la page sera rechargée à la lecture
        PIECES.push({ file: f, doc, page, items: t.items, cls, skip: cls.kind === 'plan' && cls.partial });
      } catch (e) { log('  ✖ illisible : ' + f.name + ' (' + e.message + ')'); }
    }
    log(PIECES.length + ' pièces déposées.', 1);
    renderPieces();
    if ($('#v-plans').classList.contains('on')) renderViewer();
  }
  const PICTO = { plan: 'M4 4h16v16H4zM4 12h9M13 4v8M13 16h7', coupe: 'M3 18h18M5 18V9l7-5 7 5v9M5 12h14', facade: 'M4 20V8l8-5 8 5v12zM8 12h3v3H8zM13 12h3v3h-3z', vue: 'M3 15l9-5 9 5-9 5zM3 15v-6l9-5 9 5v6', masse: 'M4 4h16v16H4zM8 8h5v4H8z', annexe: 'M5 19V9l7-5 7 5v10z', pic: 'M4 20h16M7 20V8h4v12M14 20v-6h3v6', cctp: 'M6 3h9l4 4v14H6zM9 9h7M9 13h7M9 17h5', dpgf: 'M5 4h14v16H5zM5 9h14M5 14h14M11 4v16', autre: 'M6 3h12v18H6z' };
  function renderPieces() {
    const order = ['cctp', 'dpgf', 'plan', 'annexe', 'coupe', 'facade', 'vue', 'masse', 'pic', 'autre'];
    let h = IFCFILE ? `<div class="grp">Maquette numérique</div><div class="pc"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--acc)" stroke-width="1.4" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg><div class="nm"><div><b>${esc(IFCFILE.name)}</b></div><div class="small muted">IFC · ${(IFCFILE.size / 1e6).toFixed(1).replace('.', ',')} Mo · source de la maquette 3D</div></div><div></div></div>`
      : `<div class="note warn"><b>Maquette IFC manquante.</b> La maquette 3D ne se construit plus à partir des plans PDF : demandez au maître d’œuvre la maquette numérique du projet au format IFC (2x3 ou 4) et déposez-la ici avec les PDF.</div>`;
    order.forEach(k => {
      const L = PIECES.filter(p => p.cls.kind === k); if (!L.length) return;
      h += `<div class="grp">${KINDS[k]} (${L.length})</div>`;
      L.forEach(p => {
        const i = PIECES.indexOf(p), c = p.cls;
        let extra = '';
        if (k === 'plan') extra = `<div class="small muted">${c.level ? 'Niveau ' + esc(c.level.name) : 'plan'} · éch. 1/${c.scale || '?'} · affiché tel quel (onglet Plans)</div>`;
        else if (k === 'cctp' || k === 'dpgf') extra = `<div class="small muted">Lot ${esc(c.lot || '?')} · ${p.doc.numPages} pages</div>`;
        else extra = `<div class="small muted">${esc((c.title || '').slice(0, 70))}</div>`;
        h += `<div class="pc"><svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="var(--ink2)" stroke-width="1.4" aria-hidden="true"><path d="${PICTO[k] || PICTO.autre}"/></svg>
          <div class="nm"><div title="${esc(p.file.name)}"><b>${esc(p.file.name)}</b></div>${extra}</div>
          <div><select data-i="${i}" aria-label="Type de pièce">${Object.keys(KINDS).map(x => `<option value="${x}" ${x === k ? 'selected' : ''}>${KINDS[x]}</option>`).join('')}</select>
          ${(k === 'cctp' || k === 'dpgf') ? `<div class="row small"><label>lot</label><input data-lot="${i}" value="${esc(c.lot || '')}" style="width:44px"></div>` : ''}</div></div>`;
      });
    });
    $('#pcs').innerHTML = h;
    $$('#pcs select[data-i]').forEach(s => s.onchange = () => { PIECES[+s.dataset.i].cls.kind = s.value; renderPieces(); });
    $$('#pcs select[data-lev]').forEach(s => s.onchange = () => { const n = +s.value; PIECES[+s.dataset.lev].cls.level = { n, name: n < 0 ? 'R' + n : n === 0 ? 'RDC' : 'R+' + n }; });
    $$('#pcs input[data-sc]').forEach(s => s.onchange = () => { PIECES[+s.dataset.sc].cls.scale = +s.value || 100; });
    $$('#pcs input[data-skip]').forEach(s => s.onchange = () => { PIECES[+s.dataset.skip].skip = !s.checked; });
    $$('#pcs input[data-lot]').forEach(s => s.onchange = () => { PIECES[+s.dataset.lot].cls.lot = s.value.padStart(2, '0'); });
    const nE = PIECES.filter(p => p.cls.kind === 'cctp').length, nD = PIECES.filter(p => p.cls.kind === 'dpgf').length, nG = PIECES.filter(p => !['cctp', 'dpgf'].includes(p.cls.kind)).length;
    $('#bBuild').disabled = !IFCFILE;
    $('#needs').innerHTML = (IFCFILE ? `Maquette IFC : <b>${esc(IFCFILE.name)}</b>` : '<b style="color:var(--bad)">Maquette IFC à déposer</b>') + ` · ${nE} CCTP · ${nD} CDPGF · ${nG} pièce(s) graphique(s), affichées telles quelles dans l’onglet Plans.`;
  }
  $('#bBuild').onclick = async () => {
    if (!IFCFILE) return;
    $('#bBuild').disabled = true; $('#log').textContent = ''; const t0 = performance.now();
    try {
      let k = 0; const steps = PIECES.filter(p => p.cls.kind === 'cctp' || p.cls.kind === 'dpgf').length + 2;
      const lg = m => { if (/^Lecture|^Maquette IFC/.test(m)) k++; log(m, Math.min(0.98, k / steps)); };
      const M = await IFCX.read(await IFCFILE.text(), IFCFILE.name, lg);
      const P2 = await PROJ.assembleIfc(M, IFCFILE, PIECES, lg);
      PROJ.prepare(P2); setProject(P2, { tab: 'assoc' });
      log(`Dossier lu en ${Math.round((performance.now() - t0) / 1000)} s : ${M.el.length} ouvrages de la maquette en ${Object.keys(M.fams).length} familles, ${P2.levels.length} niveaux, ${P2.rooms.length} locaux, ${P2.cctp.length} CCTP, ${P2.dpgf.length} CDPGF.`, 1);
    } catch (e) { log('✖ ' + e.message); console.error(e); }
    $('#bBuild').disabled = false;
  };
  // géométrie seule (projet enregistré, ou exemple) : le fichier IFC est relu et la 3D refaite
  async function loadIfcGeometry(src, name) {
    const nom = name || src.name, b = $('#banner');
    b.innerHTML = 'Lecture de la maquette IFC « ' + esc(nom) + ' »…'; b.style.display = 'block';
    await new Promise(r => setTimeout(r, 30));
    try {
      const txt = typeof src === 'string' ? src : await src.text();
      const M = await IFCX.read(txt, nom, () => {});
      if (P && P.ifc && P.ifc.nom === nom) { if (M.el.length !== P.ifc.el.length) banner('La maquette déposée ne correspond pas exactement à celle du projet (' + M.el.length + ' ouvrages au lieu de ' + P.ifc.el.length + ').'); else b.style.display = 'none'; }
      built3d = false; if ($('#v-3d').classList.contains('on') || $('#v-assoc').classList.contains('on')) { V3.build(P); built3d = true; V3.view('iso'); }
      if ($('#v-assoc').classList.contains('on')) renderAssoc();
    } catch (e) { banner('Maquette IFC illisible : ' + esc(e.message)); console.error(e); }
  }

  // ------------------------------------------------------------------ projet chargé
  let isExample = false;
  function setProject(p, opts = {}) {
    P = p; built3d = false; qsel.clear(); isExample = !!opts.example;
    if (VIS.key && VIS.key.startsWith('x:') && !isExample) VIS.close();
    (P.issues || []).forEach((i, k) => { if (i.niv !== 'info') qsel.add(k); });
    P.rooms.forEach(r => { r.f = r.f || V3.fonction(r.n, r.ext); });
    $('#projName').textContent = '· ' + (P.nom || 'Projet');
    renderLevels(); renderTools(); legend();
    const cur = $$('#tabs button').find(b => b.classList.contains('on')).dataset.v;
    if (cur === '3d') { V3.build(P); built3d = true; V3.view('iso'); } else show(opts.tab || '3d');
    if (opts.banner) { const b = $('#banner'); b.innerHTML = opts.banner + '<button id="bannerX">Compris</button>'; b.style.display = 'block'; $('#bannerX').onclick = () => b.style.display = 'none'; const keep = b.innerHTML; setTimeout(() => { if (b.innerHTML === keep) b.style.display = 'none'; }, 15000); }
    else if (P.source === 'ifc' && !(IFCX.RT && IFCX.RT.nom === P.ifc.nom) && !opts.example) banner(`Projet ouvert sans sa maquette : déposez le fichier IFC « ${esc(P.ifc.nom)} » dans l’onglet Dossier pour voir la 3D (les associations et les pièces écrites sont déjà là).`, () => show('dossier'), 'Aller au dossier');
  }
  function renderLevels() {
    const c = $('#levCard'); if (!P) { c.style.display = 'none'; return; }
    c.style.display = 'block';
    if (P.source === 'ifc') {
      const M = P.ifc, F = Object.values(M.fams), AS = P.assoc || {}, nA = Object.keys(M.fams).filter(k => AS[k] && AS[k].arts && AS[k].arts.length).length, nV = Object.values(AS).filter(a => a.ok).length;
      c.innerHTML = `<h3 style="margin-top:0">La maquette du projet</h3>
        <div class="kpis"><div><small>Ouvrages</small><b>${M.el.length.toLocaleString('fr-FR')}</b></div><div><small>Familles</small><b>${F.length}</b></div><div><small>Associées au CCTP</small><b>${nA}</b></div><div><small>Validées</small><b>${nV}</b></div><div><small>Locaux</small><b>${P.rooms.length}</b></div></div>
        <p class="small muted">Fichier <b>${esc(M.nom)}</b> · ${esc(M.schema)} · ${esc(M.emetteur || 'logiciel inconnu')}. Les quantités (surfaces, volumes, longueurs, nombres) sont mesurées sur la géométrie de chaque ouvrage.</p>
        <h4>Niveaux de la maquette</h4><div class="tbl"><table><thead><tr><th>Niveau</th><th class="n">Altitude</th><th class="n">Hauteur</th><th>Niveaux du fichier regroupés</th></tr></thead><tbody>${P.levels.map(L => `<tr><td><b>${esc(L.nom)}</b></td><td class="n">${f2(L.z)}</td><td class="n">${f2(L.h)}</td><td class="small">${esc((L.ifc || []).join(' · '))}</td></tr>`).join('')}</tbody></table></div>
        <div class="row"><button class="btn pri" id="goAssoc">Vérifier les associations</button></div>
        <h4>Pièces utilisées</h4><ul class="doc">${P.pieces.filter(p => p.used).map(p => `<li>${esc(p.nom)} <span class="muted">(${p.kind === 'ifc' ? 'maquette IFC' : KINDS[p.kind] || p.kind})</span></li>`).join('') || '<li class="muted">—</li>'}</ul>`;
      $('#goAssoc').onclick = () => show('assoc');
      return;
    }
    const nb = P.rooms.filter(r => r.a && !r.ext), ok = nb.filter(r => r.fid === 'bon').length;
    c.innerHTML = `<h3 style="margin-top:0">Contrôle de la lecture</h3>
      <div class="kpis"><div><small>Locaux relevés</small><b>${P.rooms.length}</b></div><div><small>Surfaces à ±15 %</small><b>${nb.length ? Math.round(ok / nb.length * 100) : '—'} %</b></div><div><small>Murs</small><b>${P.walls.length}</b></div><div><small>Baies</small><b>${P.open.length}</b></div></div>
      <h4>Niveaux (modifiables)</h4><div class="tbl"><table><thead><tr><th>Niveau</th><th class="n">Altitude (m)</th><th class="n">Hauteur d'étage</th><th class="n">Plancher</th><th>Source</th><th>Recalage</th></tr></thead><tbody>
      ${P.levels.map((L, i) => `<tr><td><b>${esc(L.nom)}</b><div class="small muted">${esc(L.piece || '')}</div></td><td class="n"><input data-lz="${i}" value="${L.z}"></td><td class="n"><input data-lh="${i}" value="${L.h}"></td><td class="n"><input data-ls="${i}" value="${L.slab}"></td><td><span class="pill ${L.src === 'hyp' ? 'mid' : 'ok'}">${L.src === 'hyp' ? 'hypothèse' : L.src}</span></td><td class="small">${esc(L.align || '')}</td></tr>`).join('')}</tbody></table></div>
      ${(P.notes || []).map(n => `<div class="note warn">${esc(n.t)}</div>`).join('')}
      <h4>Pièces utilisées</h4><ul class="doc">${P.pieces.filter(p => p.used).map(p => `<li>${esc(p.nom)} <span class="muted">(${KINDS[p.kind] || p.kind})</span></li>`).join('') || '<li class="muted">—</li>'}</ul>`;
    $$('#levCard input').forEach(i => i.onchange = () => { const k = +(i.dataset.lz || i.dataset.lh || i.dataset.ls), v = parseFloat(i.value.replace(',', '.')); if (isNaN(v)) return; if (i.dataset.lz) P.levels[k].z = v; if (i.dataset.lh) P.levels[k].h = v; if (i.dataset.ls) P.levels[k].slab = v; P.levels[k].src = 'élève'; PROJ.defaultRoofs && keepRoofs(); built3d = false; });
  }
  function keepRoofs() { P.roofs.forEach(r => { const L = P.levels[r.lev]; if (r.type === 'terrasse' && L) r.z = +(L.z + L.h).toFixed(2); }); }

  // ------------------------------------------------------------------ outils 3D
  const T = { cuts: [{ axe: 'y', on: false, v: 1.2 }, { axe: 'x', on: false, v: 0 }, { axe: 'z', on: false, v: 0 }] };
  function renderTools() {
    if (!P) return;
    const B = PROJ.bbox((P.source === 'ifc' ? P.rooms.flatMap(r => r.polys.flat()) : P.fp.flatMap(f => f.o)).concat([[0, 0]]));
    T.cuts[1].min = B.x0; T.cuts[1].max = B.x1; if (!T.cuts[1].v) T.cuts[1].v = (B.x0 + B.x1) / 2;
    T.cuts[2].min = B.y0; T.cuts[2].max = B.y1; if (!T.cuts[2].v) T.cuts[2].v = (B.y0 + B.y1) / 2;
    const zmax = Math.max(...P.levels.map(l => l.z + l.h)) + 3;
    T.cuts[0].min = -0.2; T.cuts[0].max = zmax;
    const S = V3.S;
    $('#tools').innerHTML = `
      <h4 style="margin-top:2px">Rendu</h4><div class="seg" id="tStyle">${[['blanc', 'Maquette blanche'], ['photo', 'Matériaux'], ['crayon', 'Crayon'], ['bic', 'Bic'], ['anime', 'Animé']].map(([k, l]) => `<button class="btn ${S.style === k ? 'on' : ''}" data-s="${k}">${l}</button>`).join('')}</div>
      <h4>Projection</h4><div class="seg" id="tProj"><button class="btn ${S.proj === 'persp' ? 'on' : ''}" data-p="persp">Perspective</button><button class="btn ${S.proj === 'axo' ? 'on' : ''}" data-p="axo">Axonométrie</button></div>
      <h4>Point de vue</h4><div class="seg" id="tView">${[['iso', 'Général'], ['dessus', 'Dessus'], ['sud', 'Sud'], ['nord', 'Nord'], ['est', 'Est'], ['ouest', 'Ouest']].map(([k, l]) => `<button class="btn" data-w="${k}">${l}</button>`).join('')}</div>
      <h4>Affichage</h4><div class="seg" id="tMode">${[['plein', 'Plein'], ['translucide', 'Translucide'], ['filaire', 'Filaire'], ['fonction', 'Par fonction']].map(([k, l]) => `<button class="btn ${S.mode === k ? 'on' : ''}" data-m="${k}">${l}</button>`).join('')}</div>
      <div class="row" style="margin-top:8px"><label class="small"><input type="checkbox" id="tRoof" ${S.roofs ? 'checked' : ''}> Toitures</label><label class="small"><input type="checkbox" id="tSite" ${S.layer.site ? 'checked' : ''}> Terrain</label></div>
      <h4>Éclaté par niveaux</h4><input type="range" id="tExp" min="0" max="1" step="0.01" value="${S.explode}" aria-label="Éclaté">
      <div class="chips" id="tIso"><button class="chip ${S.iso == null ? 'on' : ''}" data-l="-1">Tous</button>${P.levels.map((L, i) => `<button class="chip ${S.iso === i ? 'on' : ''}" data-l="${i}">${esc(L.nom)}</button>`).join('')}</div>
      <h4>Coupes</h4>${T.cuts.map((c, i) => `<div class="row"><label class="small"><input type="checkbox" data-c="${i}" ${c.on ? 'checked' : ''}> ${['Horizontale', 'Verticale est-ouest', 'Verticale nord-sud'][i]}</label><span class="small muted" id="cv${i}">${f2(c.v)}</span></div><input type="range" data-cr="${i}" min="${c.min}" max="${c.max}" step="0.05" value="${c.v}" aria-label="Position de la coupe">`).join('')}
      <h4>Chercher un local</h4><div class="search"><input id="tFind" placeholder="nom, fonction, code…" autocomplete="off" aria-label="Chercher un local"></div><div id="tRes" class="small"></div>
      <div class="row" style="margin-top:10px"><button class="btn" id="tShot">Capture PNG</button></div>`;
    $$('#tStyle .btn').forEach(b => b.onclick = () => { const s = b.dataset.s; if (s === 'anime') { V3.S.style = 'blanc'; V3.build(P); V3.animate(phase); } else { V3.S.style = s; V3.stopAnim(); V3.build(P); } $$('#tStyle .btn').forEach(x => x.classList.toggle('on', x === b)); });
    $$('#tProj .btn').forEach(b => b.onclick = () => { V3.setProj(b.dataset.p); $$('#tProj .btn').forEach(x => x.classList.toggle('on', x === b)); });
    $$('#tView .btn').forEach(b => b.onclick = () => V3.view(b.dataset.w));
    $$('#tMode .btn').forEach(b => b.onclick = () => { V3.S.mode = b.dataset.m; V3.applyLook(); $$('#tMode .btn').forEach(x => x.classList.toggle('on', x === b)); });
    $('#tRoof').onchange = e => { V3.S.roofs = e.target.checked; V3.applyLook(); };
    $('#tSite').onchange = e => { V3.S.layer.site = e.target.checked; V3.build(P); };
    $('#tExp').oninput = e => { V3.S.explode = +e.target.value; V3.placeLevels(); };
    $$('#tIso .chip').forEach(c => c.onclick = () => { const l = +c.dataset.l; V3.S.iso = l < 0 ? null : l; if (l >= 0 && V3.S.explode < 0.5) { V3.S.explode = 0.8; $('#tExp').value = 0.8; V3.placeLevels(); } V3.applyLook(); $$('#tIso .chip').forEach(x => x.classList.toggle('on', x === c)); });
    $$('#tools [data-c]').forEach(i => i.onchange = () => { T.cuts[+i.dataset.c].on = i.checked; V3.setCuts(T.cuts); });
    $$('#tools [data-cr]').forEach(i => i.oninput = () => { const c = T.cuts[+i.dataset.cr]; c.v = +i.value; c.on = true; $(`[data-c="${i.dataset.cr}"]`).checked = true; $('#cv' + i.dataset.cr).textContent = f2(c.v); V3.setCuts(T.cuts); });
    $('#tFind').oninput = e => find(e.target.value);
    $('#tShot').onclick = () => download('maquette-' + (P.nom || 'projet').slice(0, 30) + '.png', V3.snapshot(), true);
    requestAnimationFrame(() => V3.resize());
  }
  function phase(ph, k) { const el = $('#phase'); if (!ph) { el.style.display = 'none'; $$('#tStyle .btn').forEach(x => x.classList.toggle('on', x.dataset.s === V3.S.style)); return; } el.style.display = 'block'; el.innerHTML = `<span class="small muted">Phase ${k + 1} / 7 · ${esc(ph.lot)}</span><b>${esc(ph.t)}</b>`; }
  function find(q) {
    const u = PDFX.norm(q).trim();
    if (!u) { V3.S.filter = null; V3.applyLook(); $('#tRes').innerHTML = ''; return; }
    const L = P.rooms.filter(r => PDFX.norm(r.n).includes(u) || r.id.includes(u) || PDFX.norm(V3.FNL[r.f] || '').includes(u));
    V3.S.filter = new Set(L.map(r => r.id)); V3.applyLook();
    $('#tRes').innerHTML = `<div class="muted" style="margin:6px 0">${L.length} local(aux) · ${n2(L.reduce((s, r) => s + (r.a || r.am), 0))} m²</div>` + L.slice(0, 40).map(r => `<div class="row" style="cursor:pointer" data-r="${r.id}"><span style="flex:1">${esc(r.n)}</span><span class="muted">${esc(P.levels[r.lev].nom)} · ${n2(r.a || r.am)}</span></div>`).join('');
    $$('#tRes [data-r]').forEach(d => d.onclick = () => pickRoom(d.dataset.r));
  }
  function legend() {
    const used = new Set(P.rooms.map(r => r.f));
    $('#legend').innerHTML = Object.keys(V3.FN).filter(k => used.has(k)).map(k => `<span><i style="background:${V3.FN[k]}"></i>${V3.FNL[k]}</span>`).join('');
  }

  // ------------------------------------------------------------------ inspecteur (3D et plans)
  function roomArticles(r) {
    const out = [];
    P.cctp.forEach(l => l.articles.forEach(a => { if ((a.rooms || []).includes(r.id) || (a.tous && !r.ext && a.feuille)) out.push({ lot: l.lot, lt: l.titre, a }); }));
    return out;
  }
  function dpgfOf(lot, num) { const d = P.dpgf.find(x => x.lot === lot); return d ? d.lignes.filter(l => l.art === num) : []; }
  function cardRoom(r) {
    const L = P.levels[r.lev], fd = FIDL[r.fid] || FIDL.deduit, arts = roomArticles(r).filter(x => !x.a.tous || x.a.loc);
    const direct = arts.filter(x => (x.a.rooms || []).includes(r.id));
    return `<div class="hd"><div class="code">${esc(r.id)} · ${esc(L.nom)}</div><h2>${esc(r.n)}</h2><span class="small" style="color:${V3.FN[r.f]}">■</span> <span class="small muted">${esc(V3.FNL[r.f] || '')}</span><button class="x" aria-label="Fermer">×</button></div>
      <div class="bd"><div class="big"><div><small>Surface DCE</small><b>${r.a ? f2(r.a) + ' m²' : '—'}</b></div><div><small>Surface maquette</small><b>${f2(r.am)} m²</b></div></div>
      <dl class="kv"><dt>Niveau</dt><dd>${esc(L.nom)} · s.f ${L.z >= 0 ? '+' : ''}${f2(L.z)}</dd><dt>Hauteur</dt><dd>${r.hs ? esc(r.hs[0]) + ' ' + f2(r.hs[1]) + ' m' : '<span class="muted">non lue</span>'}</dd><dt>Fidélité</dt><dd><span class="pill ${fd[1]}">${fd[0]}</span></dd><dt>Périmètre</dt><dd>${f2(r.polys.reduce((s, p) => s + PROJ.perim(p), 0))} m</dd></dl>
      <h4>Articles du CCTP qui citent ce local (${direct.length})</h4>${direct.length ? direct.map(x => `<div class="art"><div class="t">Lot ${esc(x.lot)} · ${esc(x.a.num)} ${esc(x.a.titre)}</div>${x.a.refs.length ? '<div class="small muted">' + x.a.refs.slice(0, 4).map(z => esc(z.v)).join(' · ') + '</div>' : ''}${dpgfOf(x.lot, x.a.num).map(l => `<div class="small">DPGF : ${esc(l.u || '')} ${n2(l.q)}</div>`).join('')}</div>`).join('') : '<p class="small muted">Aucun article ne nomme ce local (les articles « tous locaux » s’appliquent).</p>'}
      <div class="row" style="margin-top:10px"><button class="btn" data-go="plan">Voir sur le plan</button><button class="btn" data-go="cadrer">Cadrer</button></div></div>`;
  }
  // ouvrage de la maquette IFC : sa famille, ses mesures, ses articles associés, ses propriétés
  function cardIfc(p) {
    const e = P.ifc.el[p.u.k], F = P.ifc.fams[e.f], A = (P.assoc || {})[e.f] || { arts: [] }, fi = IFCX.fiche(e.id);
    const arts = (A.arts || []).map(k => { const [lot, num] = k.split(':'), c = P.cctp.find(x => x.lot === lot), a = c && c.articles.find(x => x.num === num); return a ? { lot, a } : null; }).filter(Boolean);
    const props = (fi || []).map(s => `<details class="txt"><summary class="small">${esc(s.nom)} (${s.l.length})</summary><dl class="kv">${s.l.map(([k, v, u]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'number' ? n2(v) : v)}${u ? ' ' + esc(u) : ''}</dd>`).join('')}</dl></details>`).join('');
    return `<div class="hd"><div class="code">${esc(F.cf.toUpperCase())} · ${esc(P.levels[e.lev] ? P.levels[e.lev].nom : '')}</div><h2>${esc(F.lab)}</h2><div class="small muted">${esc(F.fa)}${e.n && e.n !== F.fam ? ' · ' + esc(e.n) : ''}</div><button class="x" aria-label="Fermer">×</button></div>
      <div class="bd"><div class="big"><div><small>Surface</small><b>${f2(e.q.A)} m²</b></div><div><small>Volume</small><b>${f2(e.q.V)} m³</b></div><div><small>Long. / haut.</small><b>${f2(e.q.L)} m</b></div></div>
      <dl class="kv"><dt>Classe IFC</dt><dd>${esc(e.c)}</dd><dt>Matériaux</dt><dd>${esc(e.m.join(', ') || '—')}</dd><dt>Famille</dt><dd>${F.n} ouvrage(s) · ${f2(F.A)} m² · ${f2(F.V)} m³</dd><dt>Identifiant</dt><dd class="small">${esc(e.g)}</dd></dl>
      <h4>Ouvrages du CCTP associés (${arts.length})</h4>${arts.map(x => `<div class="art"><div class="t">Lot ${esc(x.lot)} · ${esc(x.a.num)} ${esc(x.a.titre)}</div>${dpgfOf(x.lot, x.a.num).map(l => `<div class="small">CDPGF : ${esc(l.u || '')} ${n2(l.q)}${l.est ? ' · maquette ' + n2(l.est.q) : ''}</div>`).join('')}</div>`).join('') || `<p class="small muted">${A.sans ? 'Famille marquée hors marché.' : 'Aucun article associé à cette famille.'}</p>`}
      <div class="row" style="margin-top:10px"><button class="btn pri" data-gofam="${esc(e.f)}">Associations de la famille</button><button class="btn" data-hifam="${esc(e.f)}">Toute la famille</button></div>
      ${props ? `<h4>Propriétés du fichier</h4>${props}` : ''}</div>`;
  }
  function cardElem(p) {
    if (p.u && p.u.ifc) return cardIfc(p);
    const u = p.u || {}; let t = '', rows = '', kw = null;
    if (p.kind === 'mur') { const wt = P.wtypes[u.t] || {}; t = wt.nom || 'Mur'; rows = `<dt>Famille</dt><dd>${esc(P2D.LEG[wt.kind] || wt.kind || '—')}</dd><dt>Niveau</dt><dd>${esc(P.levels[u.lev].nom)}</dd><dt>Type lu</dt><dd>${esc(wt.nom || '')} <span class="pill ok">légende du plan</span></dd>`; kw = { bois: /OSSATURE BOIS|MUR.*BOIS/, ba: /VOILE|BETON/, mac: /MACONN|AGGLO|PARPAING|BRIQUE/, cloi: /CLOISON/, doub: /DOUBLAGE|CONTRE.?CLOISON/ }[wt.kind]; }
    else if (p.kind === 'baie') { const o = u.o; t = (o.ref || 'Baie') + (o.ext ? ' · menuiserie extérieure' : ' · porte intérieure'); const d = V3.openingDims(o); rows = `<dt>Largeur relevée</dt><dd>${f2(o.w)} m${o.wref ? ' <span class="muted">(cote ' + f2(o.wref) + ')</span>' : ''}</dd><dt>Hauteur</dt><dd>${f2(d.h)} m <span class="pill ${o.hsrc === 'plan' ? 'ok' : 'mid'}">${o.hsrc === 'plan' ? 'plan' : 'hypothèse'}</span></dd><dt>Allège</dt><dd>${f2(d.sill)} m</dd>${o.door ? `<dt>Porte n°</dt><dd>${esc(o.door)}</dd>` : ''}`; kw = o.ref ? new RegExp(o.ref.replace(/[.\s]+/g, '\\.?\\s*')) : (o.ext ? /MENUISERIES? EXT|CHASSIS|FENETRE/ : /BLOC.?PORTE|PORTES? INT/); }
    else if (p.kind === 'toiture') { const r = u.r; t = 'Toiture · ' + ({ terrasse: 'terrasse', '2pans': 'deux pans', '4pans': 'quatre pans', auvent: 'préau / auvent' + (r.pv ? ' photovoltaïque' : '') }[r.type]); rows = `<dt>Égout / acrotère</dt><dd>+${f2(r.z)}</dd>${r.type !== 'terrasse' ? `<dt>Pente</dt><dd>${r.slope} %</dd>` : ''}<dt>Surface</dt><dd>${f2(Math.abs(PROJ.area2(r.o)))} m² (projetée)</dd>`; kw = r.type === 'terrasse' ? /ETANCHEITE|TOITURE.?TERRASSE/ : /COUVERTURE|ZINC|TUILE|BAC ACIER/; }
    else if (p.kind === 'dalle') { t = u.lev ? 'Plancher' : 'Dallage'; rows = `<dt>Niveau</dt><dd>${esc(P.levels[u.lev].nom)}</dd><dt>Épaisseur</dt><dd>${f2(P.levels[u.lev].slab)} m <span class="pill mid">hypothèse</span></dd>`; kw = /DALLAGE|PLANCHER|DALLE/; }
    else if (p.kind === 'poteau') { t = 'Poteau'; rows = `<dt>Section</dt><dd>${f2(u.c.d)} m</dd>`; kw = /POTEAU/; }
    else if (p.kind === 'escalier') { t = u.st.n || 'Escalier'; kw = /ESCALIER/; }
    else if (p.kind === 'linteaux') { t = 'Allèges et linteaux'; kw = /LINTEAU|ALLEGE/; }
    const arts = []; if (kw) P.cctp.forEach(l => l.articles.forEach(a => { if (a.feuille && (kw.test(PDFX.norm(a.titre)) || (p.kind === 'baie' && u.o.ref && kw.test(PDFX.norm(a.texte || ''))))) arts.push({ lot: l.lot, a }); }));
    return `<div class="hd"><div class="code">ÉLÉMENT</div><h2>${esc(t)}</h2><button class="x" aria-label="Fermer">×</button></div><div class="bd"><dl class="kv">${rows}</dl>
      <h4>Articles du CCTP liés (${arts.length})</h4>${arts.slice(0, 8).map(x => `<div class="art"><div class="t">Lot ${esc(x.lot)} · ${esc(x.a.num)} ${esc(x.a.titre)}</div>${x.a.loc ? '<div class="small muted">' + esc(x.a.loc.slice(0, 140)) + '</div>' : ''}${dpgfOf(x.lot, x.a.num).map(l => `<div class="small">DPGF : ${esc(l.u || '')} ${n2(l.q)}</div>`).join('')}</div>`).join('') || '<p class="small muted">Aucun article repéré par mot-clé.</p>'}</div>`;
  }
  function inspect(p) {
    const el = $('#insp');
    if (!p) { el.classList.remove('on'); return; }
    el.innerHTML = p.kind === 'local' ? cardRoom(p.R.r) : cardElem(p); el.classList.add('on');
    el.querySelector('.x').onclick = () => { V3.S.sel = null; V3.applyLook(); el.classList.remove('on'); };
    el.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { if (b.dataset.go === 'cadrer') V3.focusRoom(p.R.r.id); });
    el.querySelectorAll('[data-gofam]').forEach(b => b.onclick = () => { AS_.sel = b.dataset.gofam; show('assoc'); });
    el.querySelectorAll('[data-hifam]').forEach(b => b.onclick = () => { const ks = famElems(b.dataset.hifam); V3.highlight(ks, true); banner(`${ks.size} ouvrage(s) de la famille « ${esc(P.ifc.fams[b.dataset.hifam].lab)} »`, () => V3.highlight(null), 'Tout réafficher'); });
  }
  const famElems = fk => { const s = new Set(); P.ifc.el.forEach((e, k) => { if (e.f === fk) s.add(k); }); return s; };
  function pickRoom(id) { const R = V3.ROOMS.find(x => x.r.id === id); if (!R) return; V3.S.sel = { kind: 'local', R }; V3.applyLook(); inspect(V3.S.sel); V3.focusRoom(id); }
  V3.S.onPick = p => inspect(p);
  V3.S.onHover = (p, e) => { const t = $('#tip'); if (!p) { t.style.opacity = 0; return; } t.style.opacity = 1; t.style.left = (e.clientX + 14) + 'px'; t.style.top = (e.clientY + 12) + 'px'; t.innerHTML = p.kind === 'local' ? `<b>${esc(p.R.r.n)}</b> · ${n2(p.R.r.a || p.R.r.am)} m²` : p.u && p.u.ifc ? (() => { const e = P.ifc.el[p.u.k], F = P.ifc.fams[e.f]; return `<b>${esc(F.lab)}</b> · ${esc(F.cf)}`; })() : esc(p.kind === 'mur' ? (P.wtypes[p.u.t] || {}).nom || 'Mur' : p.kind === 'baie' ? (p.u.o.ref || 'Baie') : p.kind); };

  // ------------------------------------------------------------------ plans : les pièces graphiques fournies, sans interprétation
  const GRAPH = ['plan', 'annexe', 'coupe', 'facade', 'vue', 'masse', 'pic', 'autre'];
  const VKIND = { plan: 'Plans de niveau', annexe: 'Plans d’annexes', coupe: 'Coupes', facade: 'Façades', vue: 'Axonométries, perspectives, insertions', masse: 'Plans masse et de situation', pic: 'Installation de chantier', autre: 'Autres pièces' };
  let exPdf = null, exPdfTried = false, visSel = null, visReady = false;
  const pdfName = n => String(n || '').replace(/\.pdf$/i, '').replace(/\s+/g, ' ').trim();
  function visSources() {
    const L = [];
    PIECES.filter(p => GRAPH.includes(p.cls.kind)).forEach(p => L.push({ key: 'f:' + p.file.name + ':' + p.file.size, nom: pdfName(p.file.name), kind: p.cls.kind, pages: p.doc.numPages,
      info: [KINDS[p.cls.kind], p.cls.scale ? 'échelle 1:' + p.cls.scale : ''].filter(Boolean).join(' · '), open: async () => ({ doc: p.doc, own: false }) }));
    if (!L.length && exPdf && isExample) exPdf.forEach(x => { const pc = (P.pieces || []).find(q => q.nom === x.nom) || {}; const kind = GRAPH.includes(pc.kind) ? pc.kind : 'autre';
      L.push({ key: 'x:' + x.f, nom: pdfName(x.nom), kind, pages: pc.pages || null, info: [KINDS[kind], pc.scale ? 'échelle 1:' + pc.scale : ''].filter(Boolean).join(' · '),
        open: async () => { const r = await fetch(x.url); if (!r.ok) throw new Error('fichier absent de l’appli'); const b = new Uint8Array(await r.arrayBuffer()); await PDFX.ensure(); return { doc: PDFE.open(b), own: true }; } }); });
    // ensemble avant détail (zones), puis du bas vers le haut
    const zone = s => /ZONE|PARTIE|DETAIL/i.test(s.nom) ? 1 : 0, lv = s => { const l = PDFX.levelOf(s.nom); return l ? l.n : 5; };
    L.sort((a, b) => zone(a) - zone(b) || lv(a) - lv(b) || a.nom.localeCompare(b.nom, 'fr'));
    return L;
  }
  async function renderViewer() {
    if (!visReady) { VIS.attach($('#visHost')); visReady = true; }
    if (isExample && !exPdfTried && window.__EXEMPLE_PDF) { exPdfTried = true; try { const r = await fetch(window.__EXEMPLE_PDF); const j = await r.json(); const base = window.__EXEMPLE_PDF.replace(/[^/]*$/, ''); exPdf = j.map(x => ({ nom: x.nom, f: x.f, url: base + encodeURIComponent(x.f) })); } catch (e) { exPdf = null; } }
    const L = visSources(), side = $('#visSide');
    let h = `<h4 style="margin-top:2px">Pièces graphiques</h4><p class="small muted" style="margin-top:0">Les feuilles du DCE telles qu’elles sont fournies : rien n’est lu ni retouché ici. Molette : zoom · glisser : déplacer · double-clic : zoom ×2.</p>`;
    if (!L.length) {
      const known = (P && P.pieces || []).filter(p => GRAPH.includes(p.kind));
      h += `<div class="note">${P ? 'Les PDF de ce projet ne sont pas ouverts dans cette session.' : 'Aucun dossier ouvert.'} Déposez les pièces graphiques pour les afficher ici.</div><div class="row"><button class="btn pri" id="visAdd">Choisir les PDF…</button></div>` +
        (known.length ? `<h4>Pièces du projet</h4><ul class="doc">${known.map(p => `<li>${esc(pdfName(p.nom))}</li>`).join('')}</ul>` : '');
      side.innerHTML = h; $('#visAdd').onclick = () => inp.click(); VIS.close(); return;
    }
    GRAPH.forEach(k => { const G = L.filter(s => s.kind === k); if (!G.length) return;
      h += `<div class="grp">${VKIND[k]} (${G.length})</div><div class="vlist">${G.map(s => `<button data-vk="${esc(s.key)}" class="${VIS.key === s.key ? 'on' : ''}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="${PICTO[k] || PICTO.autre}"/></svg><span>${esc(s.nom)}<small>${esc(s.info || '')}${s.pages > 1 ? ' · ' + s.pages + ' pages' : ''}</small></span></button>`).join('')}</div>`; });
    h += `<div class="row" style="margin-top:12px"><button class="btn" id="visAdd">Ajouter des PDF…</button></div>`;
    side.innerHTML = h;
    $('#visAdd').onclick = () => inp.click();
    side.querySelectorAll('[data-vk]').forEach(b => b.onclick = () => { visSel = b.dataset.vk; side.querySelectorAll('[data-vk]').forEach(x => x.classList.toggle('on', x === b)); VIS.show(L.find(s => s.key === visSel)); });
    if (!VIS.key || !L.some(s => s.key === VIS.key)) {
      const first = L.find(s => s.key === visSel) || L.find(s => s.kind === 'plan') || L[0]; visSel = first.key;
      side.querySelectorAll('[data-vk]').forEach(x => x.classList.toggle('on', x.dataset.vk === visSel));
      VIS.show(first);
    }
  }

  // ------------------------------------------------------------------ associations : familles de la maquette ↔ ouvrages du CCTP et lignes du CDPGF
  const PL = { lev: 0 };                                       // (compatibilité : l'ancien plan interprété n'existe plus)
  const AS_ = { sel: null, q: '', grp: 'lot', filt: 'tout', fromAssoc: false, aq: '' };
  const ST = { ok: ['validée', 'ok'], auto: ['proposée', 'mid'], none: ['sans article', 'bad'], sans: ['hors marché', 'man'], ent: ['entourage', 'man'] };
  const famState = (k, F) => { const a = (P.assoc || {})[k] || {}; if (F.ent) return 'ent'; if (a.sans) return 'sans'; if (!(a.arts || []).length) return 'none'; return a.ok ? 'ok' : 'auto'; };
  const artOf = key => { const [lot, num] = key.split(':'), c = P.cctp.find(x => x.lot === lot), a = c && c.articles.find(x => x.num === num); return a ? { lot, a, c } : null; };
  const lineOf = key => { const [lot, i] = key.split(':'), d = P.dpgf.find(x => x.lot === lot); return d && d.lignes[+i] ? { lot, i: +i, l: d.lignes[+i], d } : null; };
  const uQ = F => F.u === 'm²' ? n2(F.A) + ' m²' : F.u === 'ml' ? n2(F.L) + ' ml' : F.u === 'm³' ? n2(F.V) + ' m³' : F.n + ' u';
  function renderAssoc() {
    const side = $('#assocSide'), card = $('#assocCard');
    if (!P || P.source !== 'ifc') { side.innerHTML = '<p class="muted">Ouvrez un projet lu depuis sa maquette IFC (onglet Dossier).</p>'; card.innerHTML = ''; return; }
    const M = P.ifc, keys = Object.keys(M.fams), q = PDFX.norm(AS_.q).trim();
    const cnt = { tout: 0, auto: 0, ok: 0, none: 0, sans: 0 };
    keys.forEach(k => { const s = famState(k, M.fams[k]); cnt.tout++; if (s === 'ent' || s === 'sans') cnt.sans++; else cnt[s]++; });
    const L = keys.filter(k => { const F = M.fams[k], s = famState(k, F); if (AS_.filt !== 'tout' && !(AS_.filt === 'sans' ? (s === 'sans' || s === 'ent') : s === AS_.filt)) return false; return !q || PDFX.norm(F.fam + ' ' + F.cf + ' ' + F.m.join(' ')).includes(q); });
    // regroupement : par lot de l'article associé, ou par type d'ouvrage (classe IFC)
    const gOf = k => { if (AS_.grp === 'cls') return M.fams[k].cf; const a = ((P.assoc || {})[k] || {}).arts || []; return a.length ? ANA.lotLabel(P, a[0].split(':')[0]) : 'Sans article du CCTP'; };
    const G = new Map(); L.forEach(k => { const g = gOf(k); (G.get(g) || G.set(g, []).get(g)).push(k); });
    const groups = [...G.keys()].sort((a, b) => (a === 'Sans article du CCTP') - (b === 'Sans article du CCTP') || a.localeCompare(b, 'fr'));
    side.innerHTML = `<h4 style="margin-top:2px">Familles de la maquette (${keys.length})</h4>
      <p class="small muted" style="margin-top:0">Chaque famille d’ouvrages de la maquette IFC est rattachée à un ouvrage ou sous-ouvrage du CCTP, et à ses lignes du CDPGF. Vérifiez les propositions, corrigez-les, validez.</p>
      <div class="search"><input id="aFind" value="${esc(AS_.q)}" placeholder="Chercher une famille…" aria-label="Chercher une famille"></div>
      <div class="chips" style="margin:8px 0">${[['tout', 'Toutes'], ['auto', 'Proposées'], ['ok', 'Validées'], ['none', 'Sans article'], ['sans', 'Hors marché']].map(([k, l]) => `<button class="chip ${AS_.filt === k ? 'on' : ''}" data-af="${k}">${l} · ${cnt[k]}</button>`).join('')}</div>
      <div class="seg" style="margin-bottom:6px"><button class="btn ${AS_.grp === 'lot' ? 'on' : ''}" data-ag="lot">Par lot</button><button class="btn ${AS_.grp === 'cls' ? 'on' : ''}" data-ag="cls">Par type d’ouvrage</button></div>` +
      groups.map(g => `<div class="grp">${esc(g)} (${G.get(g).length})</div><div class="vlist">${G.get(g).sort((a, b) => M.fams[b].n - M.fams[a].n).map(k => { const F = M.fams[k], s = ST[famState(k, F)]; return `<button data-fk="${esc(k)}" class="${AS_.sel === k ? 'on' : ''}"><span class="pill ${s[1]}" style="justify-self:start;margin-top:2px" title="${s[0]}">${s[0][0].toUpperCase()}</span><span>${esc(F.lab)}<small>${esc(F.cf)}${F.fa ? ' · ' + esc(F.fa) : ''} · ${F.n} · ${uQ(F)}</small></span></button>`; }).join('')}</div>`).join('');
    $('#aFind').oninput = e => { AS_.q = e.target.value; const pos = e.target.selectionStart; renderAssoc(); const i = $('#aFind'); i.focus(); i.setSelectionRange(pos, pos); };
    $$('#assocSide [data-af]').forEach(b => b.onclick = () => { AS_.filt = b.dataset.af; renderAssoc(); });
    $$('#assocSide [data-ag]').forEach(b => b.onclick = () => { AS_.grp = b.dataset.ag; renderAssoc(); });
    $$('#assocSide [data-fk]').forEach(b => b.onclick = () => selectFam(b.dataset.fk, true));
    renderAssocCard();
    if (AS_.sel) { const b = side.querySelector(`[data-fk="${CSS.escape(AS_.sel)}"]`); if (b) b.scrollIntoView({ block: 'nearest' }); }
  }
  function selectFam(k, frame) {
    AS_.sel = k; AS_.fromAssoc = true;
    $$('#assocSide [data-fk]').forEach(b => b.classList.toggle('on', b.dataset.fk === k));
    V3.S.sel = null; V3.highlight(famElems(k), frame);
    renderAssocCard();
  }
  function renderAssocCard() {
    const card = $('#assocCard'), k = AS_.sel, F = k && P.ifc.fams[k];
    if (!F) { card.innerHTML = '<div class="bd"><p class="muted">Choisissez une famille dans la liste, ou cliquez un ouvrage dans la maquette.</p></div>'; return; }
    const A = (P.assoc[k] = P.assoc[k] || { arts: [], lignes: [] }), s = ST[famState(k, F)];
    const arts = (A.arts || []).map(artOf).filter(Boolean);
    // lignes du CDPGF : celles des articles associés et celles choisies une à une
    const lk = [...new Set((A.arts || []).flatMap(a => IFCX.linesOfArt(P, a)).concat(A.lignes || []))];
    const lines = lk.map(lineOf).filter(Boolean);
    const S = IFCX.suggest(P, F).filter(x => !(A.arts || []).includes(x.key));
    const aq = PDFX.norm(AS_.aq).trim(), found = aq ? P.cctp.flatMap(c => c.articles.filter(a => PDFX.norm(a.num + ' ' + a.titre).includes(aq)).map(a => ({ key: c.lot + ':' + a.num, lot: c.lot, num: a.num, titre: a.titre }))).slice(0, 14) : [];
    const lineRow = x => { const r = IFCX.famQty(F, x.l.u, x.l.des), all = x.l.est; const ec = all && x.l.q ? Math.round((x.l.q / all.q - 1) * 100) : null;
      return `<tr><td>L${esc(x.lot)} ${esc(x.l.num || '')}</td><td>${esc(x.l.des)}</td><td>${esc(x.l.u || '')}</td><td class="n">${n2(x.l.q)}</td><td class="n">${r.q != null ? n2(r.q) : '—'}</td><td class="n">${all ? n2(all.q) + (ec != null ? ` <span class="pill ${Math.abs(ec) <= 10 ? 'ok' : Math.abs(ec) <= 25 ? 'mid' : 'bad'}">${ec > 0 ? '+' : ''}${ec} %</span>` : '') : '—'}</td></tr>`; };
    card.innerHTML = `<div class="hd"><div class="code">${esc(F.cf.toUpperCase())} · ${F.n} OUVRAGE(S)</div><h2>${esc(F.lab)}</h2><div class="small muted">${esc(F.fa || '')}</div><span class="pill ${s[1]}">${s[0]}</span></div>
      <div class="bd"><div class="big"><div><small>Surface</small><b>${n2(F.A)} m²</b></div><div><small>Volume</small><b>${n2(F.V)} m³</b></div><div><small>Longueur</small><b>${n2(F.L)} m</b></div></div>
      <dl class="kv"><dt>Matériaux</dt><dd>${esc(F.m.join(', ') || '—')}</dd><dt>Niveaux</dt><dd>${esc(F.levs.map(i => (P.levels[i] || {}).nom).join(', '))}</dd></dl>
      <h4>Ouvrages du CCTP associés (${arts.length})</h4>
      ${arts.map(x => `<div class="art"><div class="row" style="margin:0"><div class="t" style="flex:1">Lot ${esc(x.lot)} · ${esc(x.a.num)} ${esc(x.a.titre)}</div><button class="btn" data-adel="${esc(x.lot + ':' + x.a.num)}" title="Retirer" style="padding:1px 7px">×</button></div>${x.a.loc ? `<div class="small muted">${esc(x.a.loc.slice(0, 160))}</div>` : ''}</div>`).join('') || '<p class="small muted">Aucun article associé.</p>'}
      ${lines.length ? `<h4>Lignes du CDPGF (${lines.length})</h4><div class="tbl"><table><thead><tr><th>N°</th><th>Désignation</th><th>U</th><th class="n">Q MOE</th><th class="n">Q famille</th><th class="n">Q maquette</th></tr></thead><tbody>${lines.map(lineRow).join('')}</tbody></table></div><p class="small muted">« Q famille » : cette famille seule ; « Q maquette » : toutes les familles associées à la ligne, comparé à la quantité du maître d’œuvre.</p>` : ''}
      <div class="row" style="margin-top:8px"><button class="btn pri" id="aOk">${A.ok ? 'Validée ✓' : 'Valider l’association'}</button><button class="btn" id="aSans">${A.sans ? 'Remettre au marché' : 'Hors marché'}</button></div>
      <h4>Propositions</h4>${S.slice(0, 6).map(x => `<div class="art"><div class="row" style="margin:0"><div style="flex:1"><div class="t">Lot ${esc(x.lot)} · ${esc(x.num)} ${esc(x.titre)}</div><div class="small muted">score ${n2(x.s)}</div></div><button class="btn" data-aadd="${esc(x.key)}">Associer</button></div></div>`).join('') || '<p class="small muted">Aucune proposition : cherchez l’article ci-dessous.</p>'}
      <h4>Chercher un article du CCTP</h4><div class="search"><input id="aArt" value="${esc(AS_.aq)}" placeholder="numéro ou mot du titre…" aria-label="Chercher un article"></div>
      ${found.map(x => `<div class="art"><div class="row" style="margin:0"><div class="t" style="flex:1">Lot ${esc(x.lot)} · ${esc(x.num)} ${esc(x.titre)}</div><button class="btn" data-aadd="${esc(x.key)}">Associer</button></div></div>`).join('')}</div>`;
    const done = () => { refreshEst(); renderAssoc(); };
    card.querySelectorAll('[data-adel]').forEach(b => b.onclick = () => { A.arts = A.arts.filter(x => x !== b.dataset.adel); A.lignes = (A.lignes || []).filter(l => !IFCX.linesOfArt(P, b.dataset.adel).includes(l)); A.ok = true; A.auto = false; done(); });
    card.querySelectorAll('[data-aadd]').forEach(b => b.onclick = () => { if (!A.arts.includes(b.dataset.aadd)) A.arts.push(b.dataset.aadd); A.lignes = [...new Set((A.lignes || []).concat(IFCX.linesOfArt(P, b.dataset.aadd)))]; A.sans = false; A.ok = true; A.auto = false; done(); });
    $('#aOk').onclick = () => { A.ok = !A.ok; done(); };
    $('#aSans').onclick = () => { A.sans = !A.sans; if (A.sans) { A.arts = []; A.lignes = []; } A.ok = true; done(); };
    $('#aArt').oninput = e => { AS_.aq = e.target.value; const pos = e.target.selectionStart; renderAssocCard(); const i = $('#aArt'); i.focus(); i.setSelectionRange(pos, pos); };
  }
  // les quantités « maquette » du CDPGF suivent les associations
  function refreshEst() { P.dpgf.forEach(d => d.lignes.forEach((l, i) => { l.est = PROJ.ifcEstimate(P, d.lot, i, l); })); }
  // un clic dans la maquette, dans l'onglet Associations : la famille de l'ouvrage
  const pick0 = V3.S.onPick;
  V3.S.onPick = p => { if ($('#v-assoc').classList.contains('on')) { if (p && p.u && p.u.ifc) selectFam(P.ifc.el[p.u.k].f, false); return; } pick0(p); };
  function banner(html, fn, lab) { const b = $('#banner'); b.innerHTML = html + (fn ? `<button id="bannerGo">${lab}</button>` : '') + '<button id="bannerX">×</button>'; b.style.display = 'block'; if (fn) $('#bannerGo').onclick = () => { b.style.display = 'none'; fn(); }; $('#bannerX').onclick = () => b.style.display = 'none'; }

  // ------------------------------------------------------------------ pièces écrites : quatre présentations du descriptif
  const EC = { mode: 'arbo', lot: null, q: '', lev: 0, room: null, fam: null };
  const MODES = [['arbo', 'Lot › ouvrage › sous-ouvrage'], ['local', 'Par local ou niveau'], ['element', 'Par élément de la maquette'], ['prix', 'Tableau des prix (DPGF)']];
  const DEPTH = ['', 'Chapitre', 'Ouvrage', 'Sous-ouvrage', 'Détail', 'Détail', 'Détail'];
  const eur = v => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
  function renderEcrits() {
    if (!P) return;
    const lots = ANA.lots(P);
    if (!EC.lot && lots.length) EC.lot = lots[0];
    let side = `<div class="modes" role="radiogroup" aria-label="Présentation">${MODES.map(([k, l]) => `<button class="lotb ${EC.mode === k ? 'on' : ''}" data-mode="${k}" role="radio" aria-checked="${EC.mode === k}">${l}</button>`).join('')}</div>
      <div class="search" style="margin-top:8px"><input id="eFind" value="${esc(EC.q)}" placeholder="Chercher dans le CCTP…" aria-label="Chercher dans le CCTP"></div><div style="margin-top:8px">`;
    if (EC.mode === 'arbo' || EC.mode === 'prix') {
      side += lots.map(n => { const c = P.cctp.find(x => x.lot === n), d = P.dpgf.find(x => x.lot === n), tot = EC.mode === 'prix' ? lotTotal(n) : null; return `<button class="lotb ${EC.lot === n ? 'on' : ''}" data-lot="${n}">Lot ${n}<small>${esc((c && c.titre) || (d && d.titre) || '')}${EC.mode === 'prix' ? (tot ? ' · ' + eur(tot) : '') : (c ? ' · ' + c.articles.length + ' art.' : '') + (d ? ' · DPGF ' + d.lignes.length : '')}</small></button>`; }).join('') || '<p class="muted small">Aucun CCTP ni DPGF déposé.</p>';
      if (EC.mode === 'prix') side += `<div class="card" style="margin-top:8px"><small class="muted">Total de l'offre (HT)</small><div style="font-size:18px;font-weight:700">${eur(lots.reduce((s, n) => s + lotTotal(n), 0))}</div></div>`;
    } else if (EC.mode === 'local') {
      side += `<div class="chips">${P.levels.map((L, i) => `<button class="chip ${EC.lev === i ? 'on' : ''}" data-lv="${i}">${esc(L.nom)}</button>`).join('')}</div><div style="margin-top:6px"><button class="lotb ${EC.room == null ? 'on' : ''}" data-rm="">Tout le niveau<small>${P.rooms.filter(r => r.lev === EC.lev).length} locaux</small></button>` +
        P.rooms.filter(r => r.lev === EC.lev).sort((p, q) => p.n.localeCompare(q.n)).map(r => `<button class="lotb ${EC.room === r.id ? 'on' : ''}" data-rm="${r.id}">${esc(r.n)}<small>${n2(r.a || r.am)} m²</small></button>`).join('') + '</div>';
    } else if (EC.mode === 'element') {
      const F = families(); if (!EC.fam && F.length) EC.fam = F[0].id;
      side += F.map(f => `<button class="lotb ${EC.fam === f.id ? 'on' : ''}" data-fam="${f.id}">${esc(f.nom)}<small>${esc(f.qte)}</small></button>`).join('');
    }
    side += '</div>';
    $('#ecritsSide').innerHTML = side;
    $$('#ecritsSide [data-mode]').forEach(b => b.onclick = () => { EC.mode = b.dataset.mode; renderEcrits(); });
    $$('#ecritsSide [data-lot]').forEach(b => b.onclick = () => { EC.lot = b.dataset.lot; renderEcrits(); });
    $$('#ecritsSide [data-lv]').forEach(b => b.onclick = () => { EC.lev = +b.dataset.lv; EC.room = null; renderEcrits(); });
    $$('#ecritsSide [data-rm]').forEach(b => b.onclick = () => { EC.room = b.dataset.rm || null; renderEcrits(); });
    $$('#ecritsSide [data-fam]').forEach(b => b.onclick = () => { EC.fam = b.dataset.fam; renderEcrits(); });
    $('#eFind').oninput = e => { EC.q = e.target.value; drawEcrits(); };
    drawEcrits();
  }
  function drawEcrits() {
    const q = PDFX.norm(EC.q).trim(), main = $('#ecritsMain');
    if (q) {
      const hits = []; P.cctp.forEach(l => l.articles.forEach(a => { if (PDFX.norm(a.titre + ' ' + a.texte + ' ' + a.loc).includes(q)) hits.push({ l, a }); }));
      main.innerHTML = `<h2>« ${esc(EC.q)} » dans le CCTP</h2><p class="muted small">${hits.length} article(s)</p>` + hits.slice(0, 80).map(({ l, a }) => artHTML(l, a, q)).join('');
    } else if (EC.mode === 'arbo') main.innerHTML = treeHTML(EC.lot);
    else if (EC.mode === 'local') main.innerHTML = EC.room ? roomHTML(P.rooms.find(r => r.id === EC.room)) : levelHTML(EC.lev);
    else if (EC.mode === 'element') main.innerHTML = famHTML(families().find(f => f.id === EC.fam));
    else main.innerHTML = prixHTML(EC.lot);
    main.querySelectorAll('[data-rooms] .chip, [data-r].go').forEach(c => c.onclick = () => { show('3d'); setTimeout(() => pickRoom(c.dataset.r), 60); });
    main.querySelectorAll('[data-art]').forEach(a => a.onclick = e => { e.preventDefault(); const t = main.querySelector(`details[data-num="${a.dataset.art}"]`); if (t) { let n = t; while (n && n.tagName === 'DETAILS') { n.open = true; n = n.parentElement && n.parentElement.closest('details'); } t.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
    main.querySelectorAll('[data-show]').forEach(b => b.onclick = () => { const ids = b.dataset.show.split(',').filter(Boolean); show('3d'); V3.S.filter = ids.length ? new Set(ids) : null; V3.applyLook(); banner(`${ids.length} local(aux) concerné(s) par « ${esc(b.dataset.lab || '')} »`, () => { V3.S.filter = null; V3.applyLook(); }, 'Tout réafficher'); });
    main.querySelectorAll('[data-hfams]').forEach(b => b.onclick = () => { const ks = new Set(); b.dataset.hfams.split('|').forEach(fk => famElems(fk).forEach(k => ks.add(k))); show('3d'); V3.highlight(ks, true); banner(`${ks.size} ouvrage(s) de la maquette pour « ${esc(b.dataset.lab || '')} »`, () => V3.highlight(null), 'Tout réafficher'); });
    main.querySelectorAll('[data-gofam]').forEach(b => b.onclick = () => { AS_.sel = b.dataset.gofam; show('assoc'); });
    main.querySelectorAll('[data-fshow]').forEach(b => b.onclick = () => { show('3d'); V3.S.focus = JSON.parse(b.dataset.fshow); V3.applyLook(); banner(`Éléments « ${esc(b.dataset.lab || '')} » mis en évidence dans la maquette`, () => { V3.S.focus = null; V3.applyLook(); }, 'Tout réafficher'); });
    main.querySelectorAll('[data-fold]').forEach(b => b.onclick = () => { const open = b.dataset.fold === '1'; main.querySelectorAll('details.ar').forEach(d => { d.open = open && (+d.dataset.depth || 0) <= 2; }); });
    main.querySelectorAll('input[data-pu], input[data-qe]').forEach(inp => inp.onchange = () => {
      P.prix = P.prix || {}; const k = inp.dataset.pu || inp.dataset.qe, v = parseFloat(String(inp.value).replace(/\s/g, '').replace(',', '.'));
      P.prix[k] = Object.assign(P.prix[k] || {}, inp.dataset.pu ? { pu: isNaN(v) ? null : v } : { qe: isNaN(v) ? null : v });
      renderEcrits();
    });
  }
  // ---- 1. arborescence du CCTP : chaque article est rangé sous l'article dont le numéro le précède (3 › 3.2 › 3.2.1…)
  function treeHTML(lot) {
    const c = P.cctp.find(x => x.lot === lot), d = P.dpgf.find(x => x.lot === lot);
    let h = `<h2>${esc(ANA.lotLabel(P, lot || '—'))}</h2>`;
    if (!c) return h + '<p class="muted">Pas de CCTP pour ce lot.</p>' + (d ? dpgfTable(d) : '');
    const arts = c.articles, kids = new Map(), roots = [];
    arts.forEach(a => { const par = arts.filter(b => b !== a && a.num.startsWith(b.num + '.')).sort((p, q) => q.num.length - p.num.length)[0]; if (par) { (kids.get(par) || kids.set(par, []).get(par)).push(a); } else roots.push(a); });
    const depth = a => a.num.split('.').length;
    const node = a => {
      const R = (a.rooms || []).map(id => P.rooms.find(r => r.id === id)).filter(Boolean), D = dpgfOf(c.lot, a.num), K = kids.get(a) || [], dp = depth(a);
      const FK = P.source === 'ifc' ? IFCX.famsOfArt(P, c.lot + ':' + a.num) : [], nO = FK.reduce((s, k) => s + ((P.ifc.fams[k] || {}).n || 0), 0);
      return `<details class="ar lv${Math.min(dp, 4)}" data-num="${esc(a.num)}" data-depth="${dp}" ${dp <= 2 ? 'open' : ''}><summary><span class="num">${esc(a.num)}</span><span class="tag">${DEPTH[Math.min(dp, 6)]}</span><span style="flex:1">${esc(a.titre)}</span>${K.length ? `<span class="pill man">${K.length} sous-art.</span>` : ''}${FK.length ? `<span class="pill ok">${nO} ouvrage(s) maquette</span>` : ''}${R.length ? `<span class="pill ok">${R.length} local(aux)</span>` : ''}${D.length ? `<span class="pill mid">DPGF ${D.map(x => esc(x.u || '') + ' ' + n2(x.q)).join(' · ')}</span>` : ''}</summary>
        ${a.loc ? `<div class="small" style="margin:6px 0"><b>Localisation :</b> ${esc(a.loc)}</div>` : ''}
        ${FK.length ? `<div class="small" style="margin:6px 0"><b>Dans la maquette :</b> ${FK.map(k => `<a href="#" data-gofam="${esc(k)}">${esc(P.ifc.fams[k].lab)}</a> (${P.ifc.fams[k].n})`).join(', ')} <button class="btn" data-hfams="${esc(FK.join('|'))}" data-lab="${esc(a.titre)}" style="padding:2px 8px">Voir dans la maquette</button></div>` : ''}
        ${R.length ? `<div class="row" style="margin:4px 0"><button class="btn" data-show="${R.map(r => r.id).join(',')}" data-lab="${esc(a.titre)}">Voir les locaux dans la maquette</button></div>` : ''}
        ${D.length ? `<div class="tbl"><table><thead><tr><th>Ligne DPGF</th><th>U</th><th class="n">Q MOE</th><th class="n">Q maquette</th></tr></thead><tbody>${D.map(l => `<tr><td>${esc(l.num)} ${esc(l.des)}</td><td>${esc(l.u || '')}</td><td class="n">${n2(l.q)}</td><td class="n">${l.est ? n2(l.est.q) : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${a.texte && a.texte.trim() ? `<details class="txt"><summary class="small muted">Texte de l'article</summary>${a.refs.length ? `<div class="small muted">Références : ${a.refs.map(z => esc(z.v)).join(' · ')}</div>` : ''}<pre>${esc(a.texte)}</pre></details>` : ''}
        ${K.map(node).join('')}</details>`;
    };
    h += `<div class="row" style="margin:6px 0 10px"><span class="small muted" style="flex:1">${arts.length} articles · chapitres, ouvrages, sous-ouvrages et détails rangés d'après leur numéro</span><button class="btn" data-fold="1">Déplier les ouvrages</button><button class="btn" data-fold="0">Tout replier</button></div>`;
    h += roots.map(node).join('');
    const free = d ? d.lignes.filter(l => !l.art && (l.u || l.q != null)) : [];
    if (free.length) h += `<h3>Lignes du DPGF sans article au CCTP (${free.length})</h3>` + dpgfTable({ lignes: free });
    return h;
  }
  function dpgfTable(d) { return `<div class="tbl"><table><thead><tr><th>N°</th><th>Désignation</th><th>U</th><th class="n">Q MOE</th><th class="n">Q maquette</th><th>Article</th></tr></thead><tbody>${d.lignes.map(l => `<tr><td>${esc(l.num)}</td><td>${esc(l.des)}</td><td>${esc(l.u || '')}</td><td class="n">${n2(l.q)}</td><td class="n">${l.est ? n2(l.est.q) : '—'}</td><td>${l.art ? `<a href="#" data-art="${esc(l.art)}">${esc(l.art)}</a>` : '<span class="pill bad">aucun</span>'}</td></tr>`).join('')}</tbody></table></div>`; }
  // ---- 2. par local ou par niveau : ce qui est prévu au sol, aux murs, au plafond, en menuiseries
  const CAT = [['sol', 'Sol', /SOL|CARREL|CHAPE|PLINTHE|RESINE|PVC|PARQUET|LINO|RAGREAGE|SEL\b|INSONORISATION/], ['murs', 'Murs', /PEINTURE|FAIENCE|ENDUIT|CLOISON|DOUBLAGE|MURA|TOILE|HABILLAGE/], ['plafond', 'Plafond', /PLAFOND|DALLES? 60|SUSPENDU/], ['menuis', 'Menuiseries', /PORTE|HUISSERIE|MENUISERIE|SERRURE|FERME.?PORTE|BLOC/], ['autre', 'Autres prestations', /./]];
  const catOf = a => CAT.find(([, , re]) => re.test(PDFX.norm(a.titre)))[0];
  function roomArts(r) { const out = []; P.cctp.forEach(l => l.articles.forEach(a => { if ((a.rooms || []).includes(r.id) || (a.tous && !r.ext && a.feuille)) out.push({ l, a, cat: catOf(a), direct: (a.rooms || []).includes(r.id) }); })); return out; }
  function roomHTML(r) {
    if (!r) return '<p class="muted">Local introuvable.</p>';
    const L = P.levels[r.lev], per = r.polys.reduce((s, p) => s + PROJ.perim(p), 0), hsp = r.hs ? r.hs[1] : 2.5, A = r.a || r.am;
    const doors = P.open.filter(o => o.lev === r.lev && (o.kind === 'porte' || !o.ext) && r.polys.some(p => PROJ.inPoly(o.c, p) || near(o.c, p, 0.4))).length;
    const wins = P.open.filter(o => o.lev === r.lev && o.ext && o.kind !== 'porte' && r.polys.some(p => near(o.c, p, 0.5))).length;
    const arts = roomArts(r);
    const qte = (cat, a, l) => { const D = dpgfOf(l.lot, a.num)[0], u = D ? D.u : null; if (u === 'ml' || u === 'm') return n2(per) + ' ml'; if (u === 'u' || u === 'U') return '—'; if (cat === 'sol' || cat === 'plafond') return n2(A) + ' m²'; if (cat === 'murs') return u === 'ml' || u === 'm' ? n2(per) + ' ml' : n2(per * hsp * 0.85) + ' m² (≈)'; if (cat === 'menuis') return doors + ' porte(s)'; return ''; };
    let h = `<h2>${esc(r.n)} <span class="muted small">${esc(r.id)} · ${esc(L.nom)}</span></h2><div class="kpis"><div><small>Surface DCE</small><b>${r.a ? n2(r.a) + ' m²' : '—'}</b></div><div><small>Surface maquette</small><b>${n2(r.am)} m²</b></div><div><small>Périmètre</small><b>${n2(per)} m</b></div><div><small>Hauteur</small><b>${r.hs ? esc(r.hs[0]) + ' ' + n2(hsp) + ' m' : '—'}</b></div><div><small>Portes · fenêtres</small><b>${doors} · ${wins}</b></div></div>
      <div class="row" style="margin:8px 0"><button class="btn go" data-r="${r.id}">Voir ce local dans la maquette</button></div>`;
    CAT.forEach(([k, lab]) => {
      const L2 = arts.filter(x => x.cat === k && (x.direct || k !== 'autre')); if (!L2.length) return;
      h += `<h3>${lab}</h3><div class="tbl"><table><thead><tr><th>Lot</th><th>Art.</th><th>Prestation</th><th>Quantité pour ce local</th><th>DPGF</th></tr></thead><tbody>${L2.map(({ l, a, direct }) => `<tr><td>${esc(l.lot)}</td><td>${esc(a.num)}</td><td>${esc(a.titre)}${direct ? '' : ' <span class="pill man">tous locaux</span>'}</td><td>${esc(qte(k, a, l))}</td><td class="small">${dpgfOf(l.lot, a.num).map(x => esc(x.u || '') + ' ' + n2(x.q)).join(' · ')}</td></tr>`).join('')}</tbody></table></div>`;
    });
    if (!arts.some(x => x.direct)) h += '<p class="muted">Aucun article du CCTP ne nomme ce local : il relève des articles « tous locaux » ou d\u2019une localisation à préciser (voir Analyse › Questions).</p>';
    return h;
  }
  const near = (pt, poly, d) => { for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9; let t = ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t)); if (Math.hypot(pt[0] - a[0] - t * dx, pt[1] - a[1] - t * dy) < d) return true; } return false; };
  function levelHTML(lev) {
    const L = P.levels[lev], R = P.rooms.filter(r => r.lev === lev).sort((p, q) => p.n.localeCompare(q.n));
    return `<h2>${esc(L.nom)} <span class="muted small">${R.length} locaux · ${n2(R.filter(r => !r.ext).reduce((s, r) => s + (r.a || r.am), 0))} m² intérieurs</span></h2><div class="tbl"><table><thead><tr><th>Local</th><th class="n">Surface</th>${CAT.slice(0, 4).map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${R.map(r => { const A = roomArts(r).filter(x => x.direct); return `<tr class="clic" data-rm2="${r.id}"><td>${esc(r.n)}</td><td class="n">${n2(r.a || r.am)}</td>${CAT.slice(0, 4).map(([k]) => `<td class="small">${A.filter(x => x.cat === k).map(x => 'L' + esc(x.l.lot) + ' ' + esc(x.a.num)).join(', ') || '<span class="muted">—</span>'}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div><p class="small muted">Cliquez un local pour voir le détail de ses prestations et de ses quantités.</p>`;
  }
  document.addEventListener('click', e => { const tr = e.target.closest && e.target.closest('tr[data-rm2]'); if (tr && EC.mode === 'local') { EC.room = tr.dataset.rm2; renderEcrits(); } });
  // ---- 3. par élément de la maquette : familles d'éléments, leurs quantités mesurées, leurs articles et lignes de prix
  const FKW = { ba: /VOILE|BETON BANCHE|BETON ARME/, mac: /MACONN|AGGLO|PARPAING|BRIQUE|BLOC/, bois: /OSSATURE BOIS|MUR.*BOIS|MOB\b/, cloi: /CLOISON/, doub: /DOUBLAGE|CONTRE.?CLOISON/, met: /METALL/, autre: /MUR/ };
  function families() {
    if (P.source === 'ifc') return Object.entries(P.ifc.fams).filter(([, F]) => !F.ent).sort((a, b) => a[1].cf.localeCompare(b[1].cf, 'fr') || b[1].n - a[1].n).map(([k, F]) => ({ id: k, nom: F.lab + ' · ' + F.cf, qte: F.n + ' · ' + uQ(F), ifc: true }));
    const out = [], ofLev = (P.levels[P.levels.length - 1] || {}).h || 3;
    const byT = new Map(); P.walls.forEach(w => { const L = w.a && w.b ? Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) : PROJ.wallLen(w).L, H = (P.levels[w.lev] || {}).h || ofLev; const k = w.t || '?'; const e = byT.get(k) || { L: 0, S: 0, n: 0 }; e.L += L; e.S += L * H; e.n++; byT.set(k, e); });
    byT.forEach((e, k) => { const wt = P.wtypes[k] || {}; out.push({ id: 'mur:' + k, nom: wt.nom || 'Murs', kind: wt.kind || 'autre', t: k, qte: `${n2(e.L)} m · ${n2(e.S)} m²`, L: e.L, S: e.S, n: e.n, fam: 'mur' }); });
    const P_ = P.open.filter(o => (o.kind || (o.ext ? 'fenetre' : 'porte')) === 'porte'), F_ = P.open.filter(o => o.ext && (o.kind || 'fenetre') !== 'porte');
    out.push({ id: 'porte', nom: 'Portes', fam: 'porte', qte: P_.length + ' u', n: P_.length });
    out.push({ id: 'fenetre', nom: 'Fenêtres et baies de façade', fam: 'fenetre', qte: F_.length + ' u · ' + n2(F_.reduce((s, o) => s + o.w * (V3.openingDims(o).h || 1.35), 0)) + ' m²', n: F_.length });
    const pente = P.roofs.filter(r => r.type !== 'terrasse'), terr = P.roofs.filter(r => r.type === 'terrasse');
    if (pente.length) out.push({ id: 'couv', nom: 'Couvertures en pente', fam: 'toiture', qte: n2(pente.reduce((s, r) => s + Math.abs(PROJ.area2(r.o)) * Math.sqrt(1 + (r.slope / 100) ** 2), 0)) + ' m² (rampant)' });
    if (terr.length) out.push({ id: 'terr', nom: 'Toitures-terrasses', fam: 'toiture', qte: n2(terr.reduce((s, r) => s + Math.abs(PROJ.area2(r.o)), 0)) + ' m²' });
    out.push({ id: 'dalle', nom: 'Dallage et planchers', fam: 'dalle', qte: n2(P.fp.reduce((s, f) => s + Math.abs(PROJ.area2(f.o)), 0)) + ' m²' });
    if (P.cols.length) out.push({ id: 'poteau', nom: 'Poteaux', fam: 'poteau', qte: P.cols.length + ' u' });
    return out.sort((a, b) => (a.fam === 'mur' ? 0 : 1) - (b.fam === 'mur' ? 0 : 1) || (b.L || 0) - (a.L || 0));
  }
  function famHTML(f) {
    if (!f) return '<p class="muted">Aucun élément.</p>';
    if (f.ifc) {
      const F = P.ifc.fams[f.id], A = (P.assoc || {})[f.id] || { arts: [] }, arts = (A.arts || []).map(artOf).filter(Boolean);
      const lines = [...new Set((A.arts || []).flatMap(a => IFCX.linesOfArt(P, a)).concat(A.lignes || []))].map(lineOf).filter(Boolean);
      let h = `<h2>${esc(F.lab)} <span class="muted small">${esc(F.cf)}${F.fa ? ' · ' + esc(F.fa) : ''}</span></h2><div class="kpis"><div><small>Ouvrages</small><b>${F.n}</b></div><div><small>Surface</small><b>${n2(F.A)} m²</b></div><div><small>Volume</small><b>${n2(F.V)} m³</b></div><div><small>Longueur</small><b>${n2(F.L)} m</b></div><div><small>Association</small><b><span class="pill ${ST[famState(f.id, F)][1]}">${ST[famState(f.id, F)][0]}</span></b></div></div>
        <div class="row" style="margin:8px 0"><button class="btn" data-hfams="${esc(f.id)}" data-lab="${esc(F.lab)}">Mettre en évidence dans la maquette</button><button class="btn" data-gofam="${esc(f.id)}">Modifier l’association</button></div>
        <p class="small muted">Matériaux : ${esc(F.m.join(', ') || '—')}. Quantités mesurées sur la géométrie de la maquette IFC (surface d’une face pour les murs, surface vue de dessus pour les dalles, toitures et plafonds, longueur pour poutres et garde-corps).</p>`;
      h += arts.length ? '<h3>Ouvrages du CCTP associés</h3>' + arts.map(x => artHTML(x.c, x.a)).join('') : '<p class="muted">Aucun article associé : faites-le dans l’onglet Associations.</p>';
      if (lines.length) h += `<h3>Lignes du CDPGF</h3><div class="tbl"><table><thead><tr><th>Lot</th><th>N°</th><th>Désignation</th><th>U</th><th class="n">Q MOE</th><th class="n">Q famille</th><th class="n">Q maquette</th></tr></thead><tbody>${lines.map(x => { const r = IFCX.famQty(F, x.l.u, x.l.des); return `<tr><td>${esc(x.lot)}</td><td>${esc(x.l.num || '')}</td><td>${esc(x.l.des)}</td><td>${esc(x.l.u || '')}</td><td class="n">${n2(x.l.q)}</td><td class="n">${r.q != null ? n2(r.q) : '—'}</td><td class="n">${x.l.est ? n2(x.l.est.q) : '—'}</td></tr>`; }).join('')}</tbody></table></div>`;
      return h;
    }
    const KW = f.fam === 'mur' ? FKW[f.kind] || FKW.autre : { porte: /BLOC.?PORTE|PORTES?\b|HUISSERIE/, fenetre: /MENUISERIES? EXT|CHASSIS|FENETRE|BAIE|VITRAGE|MUR.?RIDEAU/, toiture: f.id === 'terr' ? /ETANCHEITE|TOITURE.?TERRASSE|ACROTERE/ : /COUVERTURE|ZINC|TUILE|BAC ACIER|CHARPENTE/, dalle: /DALLAGE|PLANCHER|DALLE|CHAPE|FORME/, poteau: /POTEAU/ }[f.fam];
    const thick = f.fam === 'mur' ? (String((P.wtypes[f.t] || {}).nom || '').match(/(\d{2,3})\s*mm/) || [])[1] : null;
    const arts = []; P.cctp.forEach(l => l.articles.forEach(a => { const T = PDFX.norm(a.titre); if (KW && KW.test(T) && (!thick || T.includes(thick) || !/\d{2,3}/.test(T))) arts.push({ l, a }); }));
    const lines = []; arts.forEach(({ l, a }) => dpgfOf(l.lot, a.num).forEach(x => lines.push({ l, a, x })));
    let h = `<h2>${esc(f.nom)}</h2><div class="kpis"><div><small>Mesuré sur la maquette</small><b>${esc(f.qte)}</b></div>${f.n ? `<div><small>Éléments</small><b>${f.n}</b></div>` : ''}<div><small>Articles du CCTP liés</small><b>${arts.length}</b></div><div><small>Lignes de prix</small><b>${lines.length}</b></div></div>
      <div class="row" style="margin:8px 0"><button class="btn" data-fshow='${JSON.stringify({ fam: f.fam, t: f.t || null, id: f.id })}' data-lab="${esc(f.nom)}">Mettre en évidence dans la maquette</button></div>`;
    if (f.fam === 'mur') h += `<p class="small muted">Surface = longueur des murs de ce type × hauteur d'étage, baies non déduites. Comparez avec les lignes du DPGF ci-dessous : l'écart doit s'expliquer (déduction des baies, hauteur sous plafond, parties non comptées…).</p>`;
    h += arts.length ? `<h3>Articles du CCTP</h3>` + arts.slice(0, 40).map(({ l, a }) => artHTML(l, a)).join('') : '<p class="muted">Aucun article repéré par mot-clé : cherchez-le dans la présentation par lot.</p>';
    if (lines.length) h += `<h3>Lignes du DPGF</h3><div class="tbl"><table><thead><tr><th>Lot</th><th>N°</th><th>Désignation</th><th>U</th><th class="n">Q MOE</th><th class="n">Q maquette</th></tr></thead><tbody>${lines.map(({ l, x }) => `<tr><td>${esc(l.lot)}</td><td>${esc(x.num)}</td><td>${esc(x.des)}</td><td>${esc(x.u || '')}</td><td class="n">${n2(x.q)}</td><td class="n">${x.est ? n2(x.est.q) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
    return h;
  }
  // ---- 4. tableau des prix : quantités du maître d'œuvre, quantités de l'entreprise, prix unitaires saisis, montants
  const pk = (lot, l, i) => lot + ':' + (l.num || '') + ':' + i;
  function lotTotal(lot) { const d = P.dpgf.find(x => x.lot === lot); if (!d || !P.prix) return 0; return d.lignes.reduce((s, l, i) => { const e = P.prix[pk(lot, l, i)]; if (!e || e.pu == null) return s; const q = e.qe != null ? e.qe : (l.q != null ? l.q : 1); return s + q * e.pu; }, 0); }
  function prixHTML(lot) {
    const d = P.dpgf.find(x => x.lot === lot); if (!d) return `<h2>${esc(ANA.lotLabel(P, lot || '—'))}</h2><p class="muted">Pas de DPGF pour ce lot.</p>`;
    const rows = d.lignes.map((l, i) => {
      const e = (P.prix || {})[pk(lot, l, i)] || {}, qe = e.qe != null ? e.qe : l.q, mt = e.pu != null ? (qe != null ? qe : 1) * e.pu : null, ec = l.est && l.q ? Math.round((l.q / l.est.q - 1) * 100) : null;
      const titre = !l.u && l.q == null;
      return titre ? `<tr class="tit"><td>${esc(l.num)}</td><td colspan="7"><b>${esc(l.des)}</b></td></tr>` : `<tr><td>${esc(l.num)}</td><td>${esc(l.des)}</td><td>${esc(l.u || '')}</td><td class="n">${n2(l.q)}</td><td class="n">${l.est ? n2(l.est.q) + (ec != null ? ` <span class="pill ${Math.abs(ec) <= 10 ? 'ok' : Math.abs(ec) <= 25 ? 'mid' : 'bad'}">${ec > 0 ? '+' : ''}${ec} %</span>` : '') : '—'}</td>
        <td class="n"><input data-qe="${pk(lot, l, i)}" value="${e.qe != null ? String(e.qe).replace('.', ',') : ''}" placeholder="${l.q != null ? n2(l.q) : ''}" aria-label="Quantité entreprise" style="width:76px;text-align:right"></td><td class="n"><input data-pu="${pk(lot, l, i)}" value="${e.pu != null ? String(e.pu).replace('.', ',') : ''}" placeholder="0,00" aria-label="Prix unitaire" style="width:76px;text-align:right"></td><td class="n">${mt != null ? eur(mt) : '—'}</td></tr>`;
    }).join('');
    return `<h2>${esc(ANA.lotLabel(P, lot))} <span class="muted small">— total HT ${eur(lotTotal(lot))}</span></h2><p class="small muted">Saisissez vos prix unitaires (et, si besoin, vos propres quantités) comme pour une réponse d'entreprise : les montants et les totaux se calculent. La colonne « Q maquette » donne la quantité mesurée sur la maquette quand une règle de mesure s'applique.</p>
      <div class="tbl"><table class="prix"><thead><tr><th>N°</th><th>Désignation</th><th>U</th><th class="n">Q MOE</th><th class="n">Q maquette</th><th class="n">Q entreprise</th><th class="n">PU HT</th><th class="n">Montant HT</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="7" class="n"><b>Total lot ${esc(lot)} HT</b></td><td class="n"><b>${eur(lotTotal(lot))}</b></td></tr></tfoot></table></div>`;
  }
  function artHTML(l, a, q) {
    const R = (a.rooms || []).map(id => P.rooms.find(r => r.id === id)).filter(Boolean), D = dpgfOf(l.lot, a.num);
    const hi = s => q ? esc(s).replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>') : esc(s);
    return `<details class="ar" data-num="${esc(a.num)}" ${q ? 'open' : ''}><summary><span class="num">${'L' + esc(l.lot) + ' '}${esc(a.num)}</span><span style="flex:1">${hi(a.titre)}</span>${a.refs.length ? `<span class="pill man">${a.refs.length} réf.</span>` : ''}${R.length ? `<span class="pill ok">${R.length} local(aux)</span>` : ''}${D.length ? `<span class="pill mid">DPGF ${D.map(x => esc(x.u || '') + ' ' + n2(x.q)).join(' · ')}</span>` : ''}</summary>
      ${a.loc ? `<div class="small" style="margin:6px 0"><b>Localisation :</b> ${hi(a.loc)}</div>` : ''}${R.length ? `<div class="chips" data-rooms style="margin:6px 0">${R.map(r => `<span class="chip" data-r="${r.id}">${esc(r.n)} · ${esc(P.levels[r.lev].nom)}</span>`).join('')}</div>` : ''}
      ${a.refs.length ? `<div class="small muted">Références : ${a.refs.map(z => esc(z.v)).join(' · ')}</div>` : ''}<pre>${hi(a.texte || '')}</pre></details>`;
  }

  // ------------------------------------------------------------------ analyse de DCE
  const AN = { tab: 'metre', lot: null };
  function renderAnalyse() {
    if (!P) { $('#anaWrap').innerHTML = '<p class="muted">Aucun projet.</p>'; return; }
    const lots = ANA.lots(P); if (!AN.lot) AN.lot = lots[0];
    const nb = P.rooms.filter(r => r.a && !r.ext), ok = nb.filter(r => r.fid === 'bon').length;
    let h = `<h2>Analyse du DCE — ${esc(P.nom)}</h2><div class="kpis"><div><small>Niveaux</small><b>${P.levels.length}</b></div><div><small>Locaux</small><b>${P.rooms.length}</b></div><div><small>Surface DCE intérieure</small><b>${n2(P.rooms.filter(r => !r.ext).reduce((s, r) => s + (r.a || 0), 0))} m²</b></div>${P.source === 'ifc' ? (() => { const K = Object.keys(P.ifc.fams).filter(k => !P.ifc.fams[k].ent), a = K.filter(k => ((P.assoc || {})[k] || {}).arts && P.assoc[k].arts.length).length; return `<div><small>Familles associées</small><b>${a} / ${K.length}</b></div>`; })() : `<div><small>Lecture des surfaces</small><b>${nb.length ? Math.round(ok / nb.length * 100) : '—'} %</b></div>`}<div><small>Lots (CCTP / DPGF)</small><b>${P.cctp.length} / ${P.dpgf.length}</b></div><div><small>Points à éclaircir</small><b>${(P.issues || []).length}</b></div></div>
      <div id="anaTabs">${[['metre', 'Métré et DPGF'], ['fiches', 'Fiche par lot'], ['questions', 'Incohérences et questions'], ['export', 'Exporter']].map(([k, l]) => `<button class="btn ${AN.tab === k ? 'on' : ''}" data-at="${k}">${l}</button>`).join('')}</div><div id="anaBody"></div>`;
    $('#anaWrap').innerHTML = h;
    $$('#anaTabs [data-at]').forEach(b => b.onclick = () => { AN.tab = b.dataset.at; renderAnalyse(); });
    const body = $('#anaBody');
    if (AN.tab === 'metre') body.innerHTML = `<p class="small muted">Le DPGF donne les quantités du maître d'œuvre « à titre indicatif » : l'entreprise doit les vérifier. ${P.source === 'ifc' ? 'Ici, chaque ligne reçoit la quantité mesurée sur la maquette IFC des familles d’ouvrages qui lui sont associées (onglet Associations) ; cliquez une ligne pour voir ces ouvrages en 3D.' : 'Ici, chaque ligne est mesurée sur la maquette quand une règle s’applique ; cliquez une ligne pour voir les locaux mesurés en 3D.'}</p>` + ANA.metre(P);
    if (AN.tab === 'fiches') body.innerHTML = `<div class="chips" style="margin-bottom:10px">${lots.map(n => `<button class="chip ${AN.lot === n ? 'on' : ''}" data-al="${n}">Lot ${n}</button>`).join('')}</div>` + (AN.lot ? ANA.fiche(P, AN.lot) : '');
    if (AN.tab === 'questions') body.innerHTML = ANA.questions(P, qsel);
    if (AN.tab === 'export') body.innerHTML = `<div class="card"><h3 style="margin-top:0">Dossier d'étude</h3><p class="small muted">Questions cochées (${qsel.size}), niveaux et surfaces, métré comparé au DPGF et fiches par lot, en une page à imprimer ou à joindre.</p><div class="row"><button class="btn pri" id="xHtml">Télécharger le dossier (HTML)</button><button class="btn" id="xCsv">Métré (CSV tableur)</button><button class="btn" id="xQ">Copier les questions</button></div><textarea id="xTxt" rows="8" style="width:100%;margin-top:10px;display:none"></textarea></div>`;
    body.querySelectorAll('[data-al]').forEach(b => b.onclick = () => { AN.lot = b.dataset.al; renderAnalyse(); });
    body.querySelectorAll('tr[data-rooms]').forEach(tr => tr.onclick = () => {
      if (tr.dataset.fams) { const ks = new Set(); tr.dataset.fams.split('|').forEach(fk => famElems(fk).forEach(k => ks.add(k))); show('3d'); V3.highlight(ks, true); banner(`${ks.size} ouvrage(s) de la maquette comptés pour cette ligne`, () => V3.highlight(null), 'Tout réafficher'); return; }
      const ids = tr.dataset.rooms.split(',').filter(Boolean); if (!ids.length) return; show('3d'); V3.S.filter = new Set(ids); V3.applyLook(); banner(`${ids.length} local(aux) mesuré(s) pour cette ligne`, () => { V3.S.filter = null; V3.applyLook(); }, 'Tout réafficher'); });
    body.querySelectorAll('[data-q]').forEach(c => c.onchange = () => { const k = +c.dataset.q; c.checked ? qsel.add(k) : qsel.delete(k); });
    body.querySelectorAll('[data-qt]').forEach(t => t.oninput = () => { P.issues[+t.dataset.qt].qEdit = t.value; });
    if ($('#xHtml')) {
      $('#xHtml').onclick = () => download('etude-dce-' + slug(P.nom) + '.html', new Blob([ANA.reportHTML(P, qsel)], { type: 'text/html' }));
      $('#xCsv').onclick = () => download('metre-dpgf-' + slug(P.nom) + '.csv', new Blob([ANA.csv(P)], { type: 'text/csv' }));
      $('#xQ').onclick = async () => { const txt = (P.issues || []).map((i, k) => [i, k]).filter(([i, k]) => qsel.has(k)).map(([i], n) => `${n + 1}. ${i.lot === '—' ? 'Tous lots' : 'Lot ' + i.lot}${i.art ? ', art. ' + i.art : ''} — ${i.qEdit || i.q}`).join('\n'); const ta = $('#xTxt'); ta.value = txt; ta.style.display = 'block'; try { await navigator.clipboard.writeText(txt); banner('Questions copiées dans le presse-papiers.'); } catch (e) { ta.select(); banner('Copie automatique refusée : le texte est sélectionné ci-dessous.'); } };
    }
  }
  const slug = s => PDFX.norm(s || 'projet').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  // enregistrement : lien de téléchargement dans le fichier hors ligne ; dans un artefact claude.ai, la capacité « downloads »
  let DL = null;
  try { if (window.claude && window.claude.use) window.claude.use('downloads').then(d => { DL = d; }).catch(() => { }); } catch (e) { }
  function dataUrlBlob(u) { const [h, b] = u.split(','), bin = atob(b), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: (h.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream' }); }
  async function download(name, blobOrUrl, isUrl) {
    const blob = isUrl ? dataUrlBlob(blobOrUrl) : blobOrUrl;
    if (DL) {
      try { await DL.save({ filename: name, data: blob }); banner('Fichier enregistré : ' + esc(name)); }
      catch (e) { if (e && e.code !== 'declined') banner('Enregistrement impossible ici (' + esc((e && e.code) || 'erreur') + ') : utilisez la version hors ligne (fichier HTML).'); }
      return;
    }
    try { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
    catch (e) { banner('Téléchargement impossible ici : utilisez la version hors ligne (fichier HTML).'); }
  }

  // ------------------------------------------------------------------ enregistrer / ouvrir / exemple
  function serial() { const c = JSON.parse(JSON.stringify(P, (k, v) => k === 'raster' || k === 'Q' ? undefined : v)); return JSON.stringify(c); }
  $('#bSave').onclick = () => { if (!P) return; download(slug(P.nom) + '.dceeduc.json', new Blob([serial()], { type: 'application/json' })); };
  $('#bOpen').onclick = () => $('#openJson').click();
  $('#openJson').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const p = JSON.parse(await f.text()); PROJ.prepare(p); setProject(p, { tab: '3d' }); } catch (er) { banner('Fichier de projet illisible : ' + er.message); } };
  $('#bExemple').onclick = () => loadExample();
  function loadExample() {
    if (!window.__EXEMPLE) { banner('Pas d’exemple embarqué dans cette version.'); return; }
    const p = JSON.parse(JSON.stringify(window.__EXEMPLE)); PROJ.prepare(p);
    const withIfc = !!window.__EXEMPLE_IFC;
    setProject(p, { tab: '3d', example: true, banner: 'Exemple : école élémentaire Fleurance (DCE 2016). La maquette 3D est la maquette numérique IFC du projet (Revit) ; ses familles d’ouvrages sont associées aux ouvrages du CCTP et aux lignes du CDPGF (onglet <b>Associations</b> : propositions à vérifier). L’onglet <b>Plans</b> montre les pièces graphiques telles qu’elles sont fournies. Déposez votre propre dossier (maquette IFC + PDF) dans l’onglet <b>Dossier</b>.' + (withIfc ? '' : ' <i>La maquette IFC de l’exemple n’est pas embarquée dans cette version : déposez-la dans l’onglet Dossier.</i>') });
    if (withIfc && !(IFCX.RT && IFCX.RT.nom === p.ifc.nom)) fetch(window.__EXEMPLE_IFC).then(r => { if (!r.ok) throw new Error('maquette absente'); return r.text(); }).then(t => loadIfcGeometry(t, p.ifc.nom)).catch(e => banner('Maquette IFC de l’exemple illisible : ' + esc(e.message)));
  }
  $('#bTheme').onclick = () => { const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; try { localStorage.setItem('dce-theme', r.dataset.theme); } catch (e) { } if (P && built3d) V3.build(P); };
  try { const t = localStorage.getItem('dce-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) { }

  // ------------------------------------------------------------------ démarrage
  V3.init($('#v3host'));
  if (window.__EXEMPLE) loadExample();
  else if (window.__EXEMPLE_URL) { show('3d'); fetch(window.__EXEMPLE_URL).then(r => r.json()).then(j => { window.__EXEMPLE = j; if (!P) loadExample(); }).catch(() => show('dossier')); }
  else show('dossier');
  return { get P() { return P; }, setProject, show, pickRoom, PIECES: () => PIECES, loadExample, PL };
})();
