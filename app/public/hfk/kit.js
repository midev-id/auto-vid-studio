// HFK: the shared runtime for every HyperFrames project in this repo (library styles, templates, videos).
// It replaces the Remotion pieces our scenes used: a tiny JSX-to-HTML renderer (h / Fragment / Sequence),
// Remotion-identical math (interpolate, spring, Easing, random) and the library kit (Full stage, MotionBlur,
// Slot whip-in, ramp/sp/step). A scene is a pure function of its frame; HFK.mount() drives it from the
// scene's paused GSAP timeline, so preview and render seek it frame-exactly.
(function () {
  if (window.HFK) return;

  // ---------- math (same formulas as Remotion 4) ----------
  const A = (a1, a2) => 1 - 3 * a2 + 3 * a1;
  const B = (a1, a2) => 3 * a2 - 6 * a1;
  const C = (a1) => 3 * a1;
  const calc = (t, a1, a2) => ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
  const slope = (t, a1, a2) => 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);
  function bezier(x1, y1, x2, y2) {
    if (x1 === y1 && x2 === y2) return (x) => x;
    const N = 11;
    const step = 1 / (N - 1);
    const samples = new Float32Array(N);
    for (let i = 0; i < N; i++) samples[i] = calc(i * step, x1, x2);
    const tForX = (x) => {
      let start = 0;
      let i = 1;
      for (; i !== N - 1 && samples[i] <= x; i++) start += step;
      i--;
      const dist = (x - samples[i]) / (samples[i + 1] - samples[i]);
      let g = start + dist * step;
      const s = slope(g, x1, x2);
      if (s >= 0.001) {
        for (let k = 0; k < 4; k++) {
          const sl = slope(g, x1, x2);
          if (sl === 0) break;
          g -= (calc(g, x1, x2) - x) / sl;
        }
        return g;
      }
      if (s === 0) return g;
      let a = start;
      let b = start + step;
      let cur;
      let tt;
      let n = 0;
      do {
        tt = a + (b - a) / 2;
        cur = calc(tt, x1, x2) - x;
        if (cur > 0) b = tt;
        else a = tt;
      } while (Math.abs(cur) > 1e-7 && ++n < 10);
      return tt;
    };
    return (x) => (x === 0 || x === 1 ? x : calc(tForX(x), y1, y2));
  }
  const Easing = {
    step0: (n) => (n > 0 ? 1 : 0),
    step1: (n) => (n >= 1 ? 1 : 0),
    linear: (t) => t,
    ease: (t) => bezier(0.42, 0, 1, 1)(t),
    quad: (t) => t * t,
    cubic: (t) => t * t * t,
    poly: (n) => (t) => Math.pow(t, n),
    sin: (t) => 1 - Math.cos((t * Math.PI) / 2),
    circle: (t) => 1 - Math.sqrt(1 - t * t),
    exp: (t) => Math.pow(2, 10 * (t - 1)),
    elastic: (b = 1) => {
      const p = b * Math.PI;
      return (t) => 1 - Math.pow(Math.cos((t * Math.PI) / 2), 3) * Math.cos(t * p);
    },
    back: (s = 1.70158) => (t) => t * t * ((s + 1) * t - s),
    bounce: (t) => {
      if (t < 1 / 2.75) return 7.5625 * t * t;
      if (t < 2 / 2.75) { const t2 = t - 1.5 / 2.75; return 7.5625 * t2 * t2 + 0.75; }
      if (t < 2.5 / 2.75) { const t2 = t - 2.25 / 2.75; return 7.5625 * t2 * t2 + 0.9375; }
      const t2 = t - 2.625 / 2.75;
      return 7.5625 * t2 * t2 + 0.984375;
    },
    bezier,
    in: (e) => e,
    out: (e) => (t) => 1 - e(1 - t),
    inOut: (e) => (t) => (t < 0.5 ? e(t * 2) / 2 : 1 - e((1 - t) * 2) / 2),
  };

  function interp1(input, iMin, iMax, oMin, oMax, opts) {
    const {easing = (x) => x, extrapolateLeft = 'extend', extrapolateRight = 'extend'} = opts || {};
    let r = input;
    if (r < iMin) {
      if (extrapolateLeft === 'identity') return r;
      if (extrapolateLeft === 'clamp') r = iMin;
      else if (extrapolateLeft === 'wrap') r = iMin + (((r - iMin) % (iMax - iMin)) + (iMax - iMin)) % (iMax - iMin);
    }
    if (r > iMax) {
      if (extrapolateRight === 'identity') return r;
      if (extrapolateRight === 'clamp') r = iMax;
      else if (extrapolateRight === 'wrap') r = iMin + ((r - iMin) % (iMax - iMin));
    }
    if (oMin === oMax) return oMin;
    r = (r - iMin) / (iMax - iMin);
    r = easing(r);
    return r * (oMax - oMin) + oMin;
  }
  function interpolate(input, inR, outR, opts) {
    if (inR.length !== outR.length) throw new Error('interpolate: ranges differ in length');
    let i = 1;
    for (; i < inR.length - 1; ++i) if (inR[i] >= input) break;
    i--;
    return interp1(input, inR[i], inR[i + 1], outR[i], outR[i + 1], opts);
  }
  const hexToRgb = (c) => {
    if (c.startsWith('rgb')) return c.match(/[\d.]+/g).map(Number).concat([1]).slice(0, 4);
    let h = c.replace('#', '');
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
    const n = (s) => parseInt(s, 16);
    return [n(h.slice(0, 2)), n(h.slice(2, 4)), n(h.slice(4, 6)), h.length === 8 ? n(h.slice(6, 8)) / 255 : 1];
  };
  function interpolateColors(input, inR, outR) {
    const cs = outR.map(hexToRgb);
    const ch = (k) => interpolate(input, inR, cs.map((c) => c[k]), {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
    return `rgba(${Math.round(ch(0))}, ${Math.round(ch(1))}, ${Math.round(ch(2))}, ${ch(3)})`;
  }

  // Remotion steps its spring frame by frame with the exact solution, which equals the closed form at t.
  function springAt(t, c, m, k) {
    const x0 = 1;
    const zeta = c / (2 * Math.sqrt(k * m));
    const w0 = Math.sqrt(k / m);
    if (zeta < 1) {
      const w1 = w0 * Math.sqrt(1 - zeta * zeta);
      const env = Math.exp(-zeta * w0 * t);
      return 1 - env * (Math.sin(w1 * t) * ((zeta * w0 * x0) / w1) + x0 * Math.cos(w1 * t));
    }
    return 1 - Math.exp(-w0 * t) * (x0 + w0 * x0 * t);
  }
  function measureSpring(fps, cfg, threshold = 0.005) {
    let f = 0;
    let rest = 0;
    while (rest < 20 && f < fps * 60) {
      const v = springAt(f / fps, cfg.damping, cfg.mass, cfg.stiffness);
      rest = Math.abs(v - 1) < threshold ? rest + 1 : 0;
      f++;
    }
    return f - 20;
  }
  function spring({frame, fps, config = {}, from = 0, to = 1, durationInFrames, delay = 0, reverse = false}) {
    const cfg = {damping: config.damping ?? 10, mass: config.mass ?? 1, stiffness: config.stiffness ?? 100};
    const natural = reverse || durationInFrames !== undefined ? measureSpring(fps, cfg) : 0;
    let fr = reverse ? (durationInFrames ?? natural) - frame : frame;
    fr = fr + (reverse ? delay : -delay);
    if (durationInFrames !== undefined) {
      if (fr > durationInFrames) return to;
      fr = fr / (durationInFrames / natural);
    }
    let v = springAt(Math.max(0, fr) / fps, cfg.damping, cfg.mass, cfg.stiffness);
    if (config.overshootClamping) v = to >= from ? Math.min(v, 1) : Math.max(v, 1);
    return from === 0 && to === 1 ? v : interpolate(v, [0, 1], [from, to]);
  }

  function mulberry32(a) {
    let t = a + 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }
  const random = (seed) => (typeof seed === 'string' ? mulberry32(hashCode(seed)) : mulberry32(seed * 10000000000));

  // ---------- JSX to HTML ----------
  const Fragment = Symbol('Fragment');
  const h = (type, props, ...children) => ({type, props: props || {}, children});
  const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'zoom', 'scale',
    'fillOpacity', 'strokeOpacity', 'stopOpacity', 'strokeWidth', 'strokeDashoffset', 'strokeMiterlimit', 'columnCount', 'aspectRatio', 'gridRow', 'gridColumn', 'animationIterationCount']);
  const kebab = (k) => (k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()).replace(/^(webkit|moz|ms)-/, '-$1-'));
  const css = (s) => {
    let out = '';
    for (const k in s) {
      const v = s[k];
      if (v === undefined || v === null || v === false || v === '') continue;
      out += kebab(k) + ':' + (typeof v === 'number' && v !== 0 && !UNITLESS.has(k) ? v + 'px' : v) + ';';
    }
    return out;
  };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attrEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // SVG attributes that stay camelCase; everything else camelCase becomes kebab-case
  const KEEP = new Set(['viewBox', 'pathLength', 'preserveAspectRatio', 'stdDeviation', 'gradientUnits', 'gradientTransform', 'patternUnits',
    'patternTransform', 'patternContentUnits', 'filterUnits', 'primitiveUnits', 'baseFrequency', 'numOctaves', 'spreadMethod', 'markerWidth',
    'markerHeight', 'refX', 'refY', 'textLength', 'lengthAdjust', 'startOffset', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'tableValues',
    'kernelMatrix', 'diffuseConstant', 'specularExponent', 'surfaceScale', 'xChannelSelector', 'yChannelSelector', 'stitchTiles', 'keyPoints',
    'keyTimes', 'keySplines', 'calcMode', 'attributeName', 'repeatCount', 'stdDeviation']);
  const ALIAS = {className: 'class', htmlFor: 'for', xlinkHref: 'xlink:href', crossOrigin: 'crossorigin'};
  const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'area', 'col', 'wbr']);

  // render context: frame, fps, size, stage (9:16 placement)
  let CTX = {frame: 0, fps: 60, width: 1920, height: 1080, durationInFrames: 1};
  const contexts = new Map();

  function render(node) {
    if (node === null || node === undefined || node === false || node === true) return '';
    if (Array.isArray(node)) return node.map(render).join('');
    if (typeof node === 'string' || typeof node === 'number') return esc(node);
    const {type, props, children} = node;
    if (type === Fragment) return render(children);
    if (type === SHIFT) {
      const prev = CTX.frame;
      const prevDur = CTX.durationInFrames;
      CTX.frame = prev - props.by;
      if (Number.isFinite(props.durationInFrames)) CTX.durationInFrames = props.durationInFrames;
      const out = render(props.node);
      CTX.frame = prev;
      CTX.durationInFrames = prevDur;
      return out;
    }
    if (typeof type === 'function') {
      const kids = children.length === 0 ? props.children : children.length === 1 ? children[0] : children;
      return render(type({...props, children: kids}));
    }
    if (type && type.$$ctx) {
      const prev = contexts.get(type.$$ctx);
      contexts.set(type.$$ctx, props.value);
      const out = render(children.length ? children : props.children);
      contexts.set(type.$$ctx, prev);
      return out;
    }
    let attrs = '';
    let inner = null;
    for (const k in props) {
      const v = props[k];
      if (k === 'children' || k === 'key' || k === 'ref' || v === undefined || v === null || v === false) continue;
      if (k === 'style') { const s = css(v); if (s) attrs += ` style="${attrEsc(s)}"`; continue; }
      if (k === 'dangerouslySetInnerHTML') { inner = v.__html; continue; }
      const name = ALIAS[k] || (KEEP.has(k) || k.startsWith('data-') || k.startsWith('aria-') ? k : kebab(k));
      attrs += v === true ? ` ${name}` : ` ${name}="${attrEsc(v)}"`;
    }
    if (VOID.has(type)) return `<${type}${attrs}>`;
    const body = inner !== null ? inner : render(children.length ? children : props.children);
    return `<${type}${attrs}>${body}</${type}>`;
  }

  const createContext = (def) => {
    const key = Symbol('ctx');
    contexts.set(key, def);
    const Provider = {$$ctx: key};
    return {Provider, $$key: key};
  };
  const useContext = (c) => contexts.get(c.$$key);

  // ---------- Remotion component stand-ins ----------
  const useCurrentFrame = () => CTX.frame;
  const useVideoConfig = () => ({fps: CTX.fps, width: CTX.width, height: CTX.height, durationInFrames: CTX.durationInFrames});
  const fill = {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column'};
  const AbsoluteFill = ({style, children, className}) => h('div', {className, style: {...fill, ...style}}, children);
  // Sequence: children are lazy vnodes, so they read the shifted frame while this subtree renders
  const SHIFT = Symbol('Shift');
  const Sequence = ({from = 0, durationInFrames = Infinity, layout, style, children}) => {
    const f = CTX.frame;
    if (f < from || f >= from + durationInFrames) return null;
    return {type: SHIFT, props: {by: from, durationInFrames, node: layout === 'none' ? children : h(AbsoluteFill, {style}, children)}, children: []};
  };
  const staticFile = (p) => 'assets/' + String(p).replace(/^\/+/, '');
  const Img = ({src, style, className, alt}) => h('img', {src, style, className, alt: alt || ''});
  // audio is declared as <audio> clips in the composition HTML, never from the render function.
  // The porting tool sets audioLog to find where each Remotion <Audio> starts.
  let audioLog = null;
  const Audio = (p) => {
    if (audioLog) audioLog.push({src: p.src, frame: CTX.frame, volume: typeof p.volume === 'function' ? p.volume(CTX.frame) : p.volume ?? 1, trim: p.startFrom ?? p.trimBefore ?? 0});
    return null;
  };
  const setAudioLog = (log) => { audioLog = log; };
  const setFrame = (frame, fps, width, height, durationInFrames) => { CTX = {frame, fps, width, height, durationInFrames}; mbN = 0; };
  const OffthreadVideo = () => null;

  // ---------- library kit (src/library/kit.tsx) ----------
  const FPS = 60;
  const sec = (t) => Math.round(t * FPS);
  const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};
  const SMOOTH = bezier(0.7, 0, 0.3, 1);
  const OUT = bezier(0.16, 1, 0.3, 1);
  const WHIP = bezier(0.75, 0, 0.2, 1);
  const ramp = (f, t0, t1, e = SMOOTH) => interpolate(f, [sec(t0), sec(t1)], [0, 1], {...clamp, easing: e});
  const sp = (f, t0 = 0, damping = 13, stiffness = 170, mass = 0.7) => spring({frame: f - sec(t0), fps: FPS, config: {damping, stiffness, mass}});
  const mix = (a, b, t) => a + (b - a) * t;
  // second-based versions for video scenes at any fps: t is the scene time in seconds
  const rampS = (t, a, b, e = SMOOTH) => interpolate(t, [a, b], [0, 1], {...clamp, easing: e});
  const spS = (t, t0 = 0, damping = 13, stiffness = 170, mass = 0.7) => (t < t0 ? 0 : spring({frame: (t - t0) * 60, fps: 60, config: {damping, stiffness, mass}}));
  const rnd = (s) => random(s);
  const step = (f, n) => Math.floor(f / n) * n;
  let mbN = 0;
  const MotionBlur = ({id, bx, by, children, style}) => {
    const on = bx > 0.4 || by > 0.4;
    const fid = `${id}-${mbN++}`;
    return h('div', {style: {...fill, ...style, filter: on ? `url(#${fid})` : undefined}},
      on ? h('svg', {width: 0, height: 0, style: {position: 'absolute'}},
        h('defs', null, h('filter', {id: fid, x: '-30%', y: '-30%', width: '160%', height: '160%', colorInterpolationFilters: 'sRGB'},
          h('feGaussianBlur', {stdDeviation: `${bx.toFixed(2)} ${by.toFixed(2)}`})))) : null,
      children);
  };
  const slotState = (f, dur, T, tin, tout, W = 1920, H = 1080) => {
    let x = 0, y = 0, s = 1, r = 0, o = 1;
    if (tin && f < T) {
      const p = 1 - WHIP(Math.min(1, Math.max(0, f / T)));
      if (tin === 'left') x = p * W;
      if (tin === 'right') x = -p * W;
      if (tin === 'up') y = p * H;
      if (tin === 'down') y = -p * H;
      if (tin === 'zoom') { s = mix(1, 0.35, p); o = 1 - p; }
      if (tin === 'spin') { r = p * -90; s = mix(1, 0.4, p); o = 1 - p; }
    }
    if (tout && f > dur - T) {
      const q = WHIP(Math.min(1, (f - (dur - T)) / T));
      if (tout === 'left') x = -q * W;
      if (tout === 'right') x = q * W;
      if (tout === 'up') y = -q * H;
      if (tout === 'down') y = q * H;
      if (tout === 'zoom') { s = mix(1, 3.2, q); o = 1 - q; }
      if (tout === 'spin') { r = q * 90; s = mix(1, 2.6, q); o = 1 - q; }
    }
    return {x, y, s, r, o};
  };
  const Slot = ({id, dur, T, tin, tout, children, w = 1920, h: hh = 1080}) => {
    const f = CTX.frame;
    const a = slotState(f, dur, T, tin, tout, w, hh);
    const b = slotState(f - 1, dur, T, tin, tout, w, hh);
    const zs = Math.abs(a.s - b.s) * 900 + Math.abs(a.r - b.r) * 6;
    const bx = Math.min(90, Math.abs(a.x - b.x) * 0.42 + zs * 0.5);
    const by = Math.min(90, Math.abs(a.y - b.y) * 0.42 + zs * 0.5);
    return h(MotionBlur, {id: `mb-${id}`, bx, by, style: {transform: `translate(${a.x}px, ${a.y}px) scale(${a.s}) rotate(${a.r}deg)`, opacity: a.o, overflow: 'hidden'}},
      typeof children === 'function' ? children(f) : children);
  };

  // stage: scenes are drawn on 1920x1080; in 9:16 they are scaled/offset with the catalog's v {s, dx, dy, bleed}
  const W = 1920;
  const H = 1080;
  const StageCtx = createContext({v: false, s: 1, dx: 0, dy: 0, bleed: true});
  const useStage = () => useContext(StageCtx);
  const useFrameInset = () => {
    const st = useStage();
    if (!st.v) return {top: 0, bottom: 0, left: 0, right: 0};
    const top = (1920 - H * st.s) / 2 + st.dy;
    const left = (1080 - W * st.s) / 2 + st.dx;
    return {top: -top / st.s, bottom: -(1920 - top - H * st.s) / st.s, left: -left / st.s, right: -(1080 - left - W * st.s) / st.s};
  };
  const EDGE = 2;
  const Bleed = ({side, k, children}) => h('div', {style: {position: 'absolute', width: W, height: H,
    transformOrigin: side === 'top' ? `0 ${EDGE}px` : `0 ${H - EDGE}px`, transform: `scaleY(${k})`, pointerEvents: 'none'}},
    h('div', {style: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, clipPath: side === 'top' ? `inset(0 0 ${H - EDGE}px 0)` : `inset(${H - EDGE}px 0 0 0)`}}, children));
  const FONT = "'Noto Sans KR', sans-serif";
  const Full = ({bg, children, style}) => {
    const st = useStage();
    const base = {...fill, background: bg, fontFamily: FONT, overflow: 'hidden', ...style};
    if (!st.v) return h('div', {style: base}, children);
    const top = (1920 - H * st.s) / 2 + st.dy;
    const kTop = Math.max(1, top / st.s / EDGE + 1);
    const kBot = Math.max(1, (1920 - top - H * st.s) / st.s / EDGE + 1);
    return h('div', {style: base},
      h('div', {style: {position: 'absolute', width: W, height: H, left: (1080 - W * st.s) / 2 + st.dx, top, transform: `scale(${st.s})`, transformOrigin: '0 0'}},
        st.bleed ? [h(Bleed, {side: 'top', k: kTop}, children), h(Bleed, {side: 'bottom', k: kBot}, children)] : null,
        h('div', {style: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0}}, children)));
  };
  const icon = (name) => staticFile(`icons/${name}`);

  // ---------- mounting ----------
  // mount(id, Component, opts): renders Component({f}) into the scene root on every timeline update.
  // opts: {fps, width, height, stage: {v,s,dx,dy,bleed}, slot: {tin, tout, T}, duration}
  function mount(id, Component, opts = {}) {
    const root = document.querySelector('[data-composition-id="' + id + '"]:not([data-composition-src])') || document.getElementById(id);
    const host = document.querySelector('[data-composition-id="' + id + '"][data-composition-src]');
    const fps = opts.fps || 60;
    const width = opts.width || Number(root.getAttribute('data-width')) || root.clientWidth || 1920;
    const height = opts.height || Number(root.getAttribute('data-height')) || root.clientHeight || 1080;
    const duration = opts.duration || Number(host && host.getAttribute('data-duration')) || Number(root.getAttribute('data-duration')) || 10;
    const stage = opts.stage || {v: false, s: 1, dx: 0, dy: 0, bleed: true};
    const out = document.createElement('div');
    out.className = 'hfk-out';
    out.style.cssText = 'position:absolute;inset:0;overflow:hidden';
    root.appendChild(out);
    let last = -1;
    const draw = (time) => {
      const frame = Math.round(time * fps);
      if (frame === last) return;
      last = frame;
      CTX = {frame, fps, width, height, durationInFrames: Math.round(duration * fps)};
      mbN = 0;
      contexts.set(StageCtx.$$key, stage);
      let tree = h(Component, {f: frame});
      if (opts.slot) {
        const T = sec(opts.slot.T ?? 0.4);
        tree = h(Slot, {id: `slot-${id}`, dur: Math.round(duration * fps), T, tin: opts.slot.tin || null, tout: opts.slot.tout || null, w: width, h: height}, tree);
      }
      out.innerHTML = render(tree);
    };
    const tl = window.gsap.timeline({paused: true});
    const st = {t: 0};
    tl.to(st, {t: duration, duration, ease: 'none', onUpdate: () => draw(st.t)}, 0);
    draw(0);
    window.__timelines = window.__timelines || {};
    window.__timelines[id] = tl;
    return tl;
  }

  // read the 9:16 placement for a library entry
  const stageFor = (aspect, v) => (aspect === '9:16'
    ? {v: true, s: (v && v.s) ?? 1, dx: (v && v.dx) ?? 0, dy: (v && v.dy) ?? 0, bleed: (v && v.bleed) ?? true}
    : {v: false, s: 1, dx: 0, dy: 0, bleed: true});
  const vars = () => (window.__hyperframes && window.__hyperframes.getVariables ? window.__hyperframes.getVariables() : {});

  window.HFK = {
    // math
    Easing, interpolate, interpolateColors, spring, random, measureSpring,
    // jsx
    h, Fragment, render, css, createContext, useContext,
    // remotion stand-ins
    useCurrentFrame, useVideoConfig, AbsoluteFill, Sequence, Img, Audio, OffthreadVideo, staticFile,
    // library kit
    FPS, W, H, sec, clamp, SMOOTH, OUT, WHIP, ramp, sp, rampS, spS, mix, rnd, step, MotionBlur, Slot, StageCtx, useStage, useFrameInset, Full, FONT, icon,
    // mounting
    mount, stageFor, vars, setAudioLog, setFrame,
  };
})();
