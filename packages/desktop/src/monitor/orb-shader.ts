// Adapted from zoefix/agent-speed v1.4.1, MIT, a94a67fcc78e5d8eea5f82d8d5e737bccf994e2c.
// Normative source: spec/prototypes/led-effects.html FS (silk_height/silkCore/noise, corona, warp, 36 LEDs).
// Application gates/halo bounds follow LedPhases.cs and OrbLed.hlsl, not the prototype's larger 1.9S stage.
// Simplex noise copyright (C) 2011 Ashima Arts / Stefan Gustavson, MIT; see monitor attribution.
export const ORB_LED_FRAGMENT_SHADER = String.raw`#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes; uniform float uS, uTime, uH, uO, uDark, uNew, uLevel, uFlash, uPeak, uSweep, uTier;
uniform float uComet, uFlow, uPhase, uPhase2, uWarp, uCorona;
uniform vec4 uWaves[4];
uniform vec4 uTicks;
uniform float uFx, uMoving, uEmbedded, uIdleSweep, uThumbnail;

const vec3 HOT = vec3(1.0, 0.969, 0.839);
vec3 toLin(vec3 c){ return pow(max(c, 0.0), vec3(2.2)); }
vec3 toSrgb(vec3 c){ return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
vec3 heat(float h){
  h = clamp(h, 0.0, 1.0);
  vec3 c0 = vec3(.486,.529,.596), c1 = vec3(.176,.831,.749), c2 = vec3(.220,.741,.973), c3 = vec3(.506,.549,.973),
       c4 = vec3(.910,.475,.976), c5 = vec3(.984,.443,.522), c6 = vec3(.984,.573,.235), c7 = vec3(.980,.800,.082);
  vec3 a; vec3 b; float t0; float t1;
  if (h < .10) { a = c0; b = c1; t0 = 0.; t1 = .10; } else if (h < .30) { a = c1; b = c2; t0 = .10; t1 = .30; }
  else if (h < .48) { a = c2; b = c3; t0 = .30; t1 = .48; } else if (h < .64) { a = c3; b = c4; t0 = .48; t1 = .64; }
  else if (h < .78) { a = c4; b = c5; t0 = .64; t1 = .78; } else if (h < .90) { a = c5; b = c6; t0 = .78; t1 = .90; }
  else { a = c6; b = c7; t0 = .90; t1 = 1.; }
  return toSrgb(mix(toLin(a), toLin(b), (h - t0) / (t1 - t0)));
}
// porcelain: deepen without muddying (gold stays gold, not khaki)
vec3 ink(vec3 c){ return pow(c, vec3(1.55)); }

// 3D simplex noise: Ashima Arts / Stefan Gustavson (MIT)
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0); const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy)); vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g; vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx; vec3 x2 = x0 - i2 + C.yyy; vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857; vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z); vec4 x_ = floor(j * ns.z); vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy; vec4 y = y_ * ns.x + ns.yyyy; vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0; vec4 s1 = floor(b1) * 2.0 + 1.0; vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy; vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x); vec3 p1 = vec3(a0.zw, h.y); vec3 p2 = vec3(a1.xy, h.z); vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0); m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float fbm(vec3 p){ float a = .5; float s = 0.; for (int i = 0; i < 4; i++) { s += a * snoise(p); p *= 2.03; a *= .5; } return s; }
float hash11(float n){ return fract(sin(n * 127.1) * 43758.5453); }
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

vec4 acc;
// dark glass: light adds up; porcelain: colors are laid on like ink
void glow(vec3 c, float a){
  a = clamp(a, 0., 1.);
  if (uDark > .5) { acc.rgb += c * a; acc.a = max(acc.a, a * .35); }
  else { acc.rgb = c * a + acc.rgb * (1. - a); acc.a = a + acc.a * (1. - a); }
}
void paint(vec3 c, float a){ a = clamp(a, 0., 1.); acc.rgb = c * a + acc.rgb * (1. - a); acc.a = a + acc.a * (1. - a); }
float easeOut(float t){ return 1. - pow(1. - clamp(t, 0., 1.), 3.); }

// Silk core, drawn over the glass body and under the gauge.
// p: orb coords (rim at r = .5, y up), r = length(p); h: heat 0..1; o: overdrive 0..1 past the redline;
// act: 0 at idle, 1 once moving; lvl: effect level (1 standard, 1.6 max); waveField: response-pulse ring field.
// Silk: a satin height field of long diagonal folds; a key light and a rim light in the speed palette glide over it.
float silk_box(vec2 p, vec2 b, float rad){
  vec2 d = abs(p) - b + rad;
  return length(max(d, 0.)) + min(max(d.x, d.y), 0.) - rad;
}

float silk_fold(float ph){ return sin(ph + .25 * sin(ph)); }
float silk_bell(float x){ return exp(-x * x); }

float silk_height(vec2 p, float t, float rip, float wave){
  float X = dot(p, vec2(.80, .60));
  float Y = dot(p, vec2(-.60, .80)) * (1. + .45 * X)
          + .03 * snoise(vec3(p * 1.1, t * .07)) + .025 * sin(X * 5. + t * .3) + .03 * sin(X * 1.6 - t * .17);
  float hgt = .5 * sin(Y * 6. + .25 * sin(X * 3.3 + t * .2) + t * .15)
            + .6 * (.7 + .3 * sin(X * 2.8 + 1. + t * .1)) * silk_fold(Y * 16.5 + .35 * sin(X * 4.1 - t * .35) + t * .6)
            + .22 * (.5 + .5 * sin(X * 3.6 - t * .25 + 2.)) * silk_fold(Y * 27. + .4 * sin(X * 4.7 + t * .4) - t * .8 + 2.);
  if (rip > 0.) {
    float packet = max(sin(Y * 4. - uTime * 2.6 + 1.3 * sin(X * 2.7)), 0.);
    hgt += rip * .05 * packet * packet * sin(Y * 44. + X * 6. - uTime * 16.);
  }
  hgt += wave * .11 * sin(length(p) * 36. - uTime * 8.);
  return hgt;
}

void silkCore(vec2 p, float r, float h, float o, float act, float lvl, bool dark, float waveField){
  float fade = smoothstep(.475, .385, r);
  if (fade <= 0.) return;
  float t = uPhase;
  float rip = uFx >= 2. && uMoving > .5 ? min(1., o * 2.5) : 0.;
  vec2 sp = p - p / max(r, 1e-3) * .03 * waveField;
  float e = .008;
  vec2 ac = vec2(-.6, .8), al = vec2(.8, .6);
  float h0 = silk_height(sp, t, rip, waveField);
  float hA = silk_height(sp + ac * e, t, rip, waveField);
  float hB = silk_height(sp - ac * e, t, rip, waveField);
  float hL = silk_height(sp + al * e, t, rip, waveField);
  vec2 g = ac * (hA - hB) / (2. * e) + al * (hL - h0) / e;
  vec3 n = normalize(vec3(-g * .05, 1.));
  // positive where the fold curves over a crest
  float crest = smoothstep(-.15, .75, -(hA - 2. * h0 + hB) / (e * e) * .006);

  float tx = min(silk_box(p - vec2(0., .03), vec2(.27, .07), .07), silk_box(p - vec2(0., -.17), vec2(.13, .06), .06));
  float textMask = mix(.3, 1., smoothstep(-.02, .1, tx));

  float az = 2.2 + .3 * sin(uPhase2 * .35);
  vec2 ld = vec2(cos(az), sin(az));
  float sl = dot(n.xy, ld);
  float ao = .2 + .8 * smoothstep(-1.6, 1.1, h0);
  float body = pow(smoothstep(-.12, .5, sl), 1.6) * ao;
  float sheen = silk_bell((sl - .3) / .11) * ao;
  float glint = silk_bell((sl - .33) / .045) * (.35 + .65 * crest) * ao;
  float rim = silk_bell((sl + .42) / .1) * (.4 + .6 * ao);

  float X = dot(p, vec2(.8, .6));
  float pk = uPeak < 1.4 ? 1. - smoothstep(.7, 1.4, uPeak) : 0.;
  float sweep = pk * silk_bell((X - mix(-.55, .6, easeOut(uPeak / 1.2))) / .13);
  float amp = (.3 + .65 * act + .3 * h + .25 * o) * (1. + .35 * (lvl - 1.)) * (1. + .3 * uFlash + .5 * waveField + 2.2 * sweep + .4 * pk);
  float k = fade * textMask * amp;

  float glide = .05 * sin(X * 3.2 - uPhase2 * .8);
  float spread = mix(.08, 1., act);
  float hotK = clamp(smoothstep(0., .3, o) + sweep, 0., 1.);
  vec3 gold = vec3(1., .84, .45);
  vec3 cBody = heat(h + (-.22 + .3 * smoothstep(-.1, .5, sl) + glide) * spread);
  vec3 cSheen0 = heat(h + (.06 + glide) * spread);
  vec3 cSheen = mix(cSheen0, mix(gold, HOT, .35), hotK);
  vec3 cGlint = mix(cSheen, HOT, .55 + .3 * hotK);
  vec3 cRim = heat(h + (-.32 - glide) * spread);

  if (dark) {
    paint(vec3(.008, .01, .016), .7 * fade);
    glow(cBody, body * .32 * k);
    glow(cSheen, sheen * .75 * k);
    glow(cGlint, glint * .7 * k);
    glow(cRim, rim * .35 * k);
    glow(mix(gold, HOT, .4), sweep * (.12 + .6 * body + .8 * sheen) * fade * textMask);
  } else {
    float tm = .4 + .6 * textMask;
    paint(vec3(.99, .985, .978), .55 * fade);
    paint(vec3(.66, .67, .72), (pow(smoothstep(.15, -.45, sl), 1.3) * .38 + (1. - ao) * .12) * fade * tm);
    glow(ink(cRim), rim * .22 * k);
    glow(mix(ink(cSheen0), vec3(.96, .66, .16), hotK), sheen * (.3 + .15 * hotK) * k);
    paint(vec3(1.), (glint * .75 + sheen * .35) * fade * tm);
    glow(ink(gold), sweep * (.1 + .4 * body) * fade * tm);
  }
}

void main(){
  float px = 1.0 / uS;
  vec2 p = (gl_FragCoord.xy - uRes * .5) / uS;
  float r = length(p);
  if (r >= .74) { outColor = vec4(0.); return; }
  float ang = degrees(atan(-p.y, p.x)); if (ang < 0.) ang += 360.;
  float u = mod(ang - 135., 360.) / 270.;
  float h = uH; float o = uO; float act = smoothstep(0., .08, h);
  float lvl = uLevel;
  bool dark = uDark > .5; bool fresh = uNew > .5;
  bool thumbnail = uThumbnail > .5;
  bool motion = uFx >= 2. && uMoving > .5 && !thumbnail && uEmbedded < .5;
  acc = vec4(0.);
  vec3 hc = heat(h);
  vec3 hcI = dark ? hc : ink(hc);
  vec3 hot = mix(hc, HOT, .55 + .45 * o);

  float waveField = 0.;
  for (int i = 0; i < 4; i++) {
    vec4 w = uWaves[i];
    if (w.x < 0. || w.x > 1.) continue;
    float rr = .1 + .4 * easeOut(w.x);
    waveField += w.y * (1. - w.x) * exp(-pow((r - rr) / .05, 2.));
  }

  // drop shadow
  float sh = smoothstep(.6, .46, length(p - vec2(0., -.03))) * (dark ? .45 : .16);
  paint(vec3(0.), sh * smoothstep(.49, .52, r));

  // aura
  float breathe = 1. + uMoving * .15 * sin(uTime * mix(1.57, 9., h));
  float aura = smoothstep(.74, .5, r) * smoothstep(.46, .52, r) * (dark ? .55 : .32) * h * breathe * (thumbnail ? 0. : 1.);
  glow(fresh ? mix(hcI, HOT, .25 * o) : hcI, aura * (1. + .6 * uFlash) * (fresh ? .8 : 1.));

  if (fresh && motion) {
    // corona: flame tongues licking off the rim
    float cAmt = smoothstep(.45, .85, h) * (.45 + .55 * o) * lvl;
    if (cAmt > .001 && r > .47 && r < .74) {
      vec2 dir = p / max(r, 1e-4);
      float rise = (r - .5) * 9. - uCorona;
      float warpN = snoise(vec3(dir * 3., rise * .5));
      float ridge = 1. - abs(snoise(vec3(dir * 7. + warpN * .35, rise)));
      ridge = pow(ridge, 5.);
      float body = .5 + .5 * snoise(vec3(dir * 2.2, uCorona * .35));
      float reach = .02 + (.06 * h + .12 * o) * pow(body, 1.4) * 1.7;
      float d = (r - .499) / reach;
      float fall = exp(-d * 2.4) * smoothstep(.49, .503, r) * smoothstep(.74, .64, r);
      float tongues = smoothstep(.45, .8, .5 + .5 * snoise(vec3(dir * 4.5, rise * .35)));
      float flame = ridge * fall * mix(.12, 1.25, tongues) * (.45 + .7 * body);
      float base = exp(-max(r - .5, 0.) / .012) * smoothstep(.49, .503, r) * .35;
      vec3 fc = mix(HOT, hc, clamp(d * .9, 0., 1.));
      glow(dark ? fc : ink(hc), (flame + base) * cAmt * (dark ? .95 : .95));
    }
    // warp streaks rushing into the orb
    float wAmt = smoothstep(.32, .62, h) * lvl;
    if (wAmt > .001 && r > .5 && r < .74) {
      float bins = 96.;
      float bi = floor(ang / 360. * bins);
      float seed = hash11(bi + 3.);
      if (seed < .18 + .42 * h) {
        float sp = .55 + seed * .9;
        float head = fract(seed * 7.3 + uWarp * sp);
        float rh = mix(.74, .51, head);
        float len = (.02 + .08 * h + .07 * o) * (.55 + seed);
        float along = (r - rh) / len;
        float acrossDeg = abs(fract(ang / 360. * bins) - .5) * 360. / bins;
        float across = radians(acrossDeg) * r;
        float line = smoothstep(.0018 + .001 * h, 0., across) * pow(smoothstep(1., 0., along), 1.6) * step(0., along);
        float fade = smoothstep(0., .3, head) * smoothstep(1., .82, head);
        vec3 wc = mix(hc, HOT, .45);
        glow(dark ? wc : ink(hc), line * fade * wAmt * (dark ? .8 : .75));
      }
    }
  }

  // body
  float disc = smoothstep(.5 + px, .5 - px, r);
  if (disc > 0.) {
    vec3 top = dark ? vec3(.106, .125, .188) : vec3(1.);
    vec3 bot = dark ? vec3(.035, .043, .063) : vec3(.906, .922, .953);
    paint(mix(bot, top, clamp(.5 + p.y, 0., 1.)), disc * (dark ? .88 : .94));
    paint(vec3(1.), smoothstep(.36, 0., length(p - vec2(-.16, .19))) * (dark ? .06 : .3) * disc);

    if (fresh && r < .475 && uEmbedded < .5) silkCore(p, r, h, o, act, lvl, dark, waveField);

    float rim = smoothstep(.5, .49, r) * smoothstep(.473, .495, r) * clamp(.5 + p.y * 1.4, 0., 1.);
    paint(vec3(1.), rim * (dark ? .14 : .55));
  }

  // gauge
  float segR = .41; float segHalfLen = .0225;
  float lit36 = h * uSweep * 36.;
  if (u <= 1. && abs(r - segR) < .1) {
    float iNear = clamp(floor(u * 36.), 0., 35.);
    float best = 1e3; float bi = iNear;
    for (int k = -1; k <= 1; k++) {
      float j = clamp(iNear + float(k), 0., 35.);
      float ca = 135. + (j + .5) * 7.5;
      float dAng = radians(mod(ang - ca + 540., 360.) - 180.);
      vec2 lp = vec2(dAng * r, r - segR);
      vec2 hb = vec2(segR * radians(5.3) * .5, segHalfLen);
      vec2 dq = abs(lp) - hb + .006;
      float sdf = length(max(dq, 0.)) + min(max(dq.x, dq.y), 0.) - .006;
      if (sdf < best) { best = sdf; bi = j; }
    }
    float seg = smoothstep(px * 1.2, -px * 1.2, best);
    float litF = clamp(lit36 - bi, 0., 1.);
    float tipI = floor(max(lit36 - .001, 0.));
    vec3 sc = heat(bi / 35.);
    if (!dark) sc = ink(sc);
    float shimmer = uTier > 3.5 && uFx >= 2. && uMoving > .5 ? .75 + .25 * hash11(bi * 13.1 + floor(uTime * 12.)) : 1.;
    float flow = 0.;
    if (fresh && motion) {
      float ph = fract(bi / 36. * 2.2 - uFlow);
      flow = pow(1. - ph, 9.) * act * (.5 + .9 * h);
    }
    vec3 lit = mix(sc, dark ? HOT : sc * 1.15, flow * .75);
    if (bi == tipI && litF > .01) lit = dark ? HOT : sc;
    float bright = litF * shimmer * (1. + .25 * uFlash + flow * .9);
    float idleBand = uIdleSweep >= 0. && uFx > .5 && uMoving > .5 ? exp(-90. * pow(bi / 35. - uIdleSweep, 2.)) : 0.;
    paint(dark ? vec3(1.) : vec3(0.), seg * ((dark ? .07 : .08) + idleBand * (dark ? .35 : .25)) * (1. - litF));
    if (dark) glow(lit, seg * bright); else paint(lit, seg * min(1., bright));
  }
  if (!thumbnail && abs(r - segR) < .17 && act > 0.) {
    float gapA = u > 1. ? min(u - 1., 4. / 3. - u) * 270. : 0.;
    float uu = u > 1. ? (u - 1. < 4. / 3. - u ? 1. : 0.) : u;
    float inLit = smoothstep(lit36 + .5, lit36 - .5, uu * 36.);
    float dRad = max(abs(r - segR) - segHalfLen, 0.) + radians(gapA) * r;
    float g = exp(-dRad / (.014 + .018 * h + .02 * o)) * inLit * act * smoothstep(.17, .1, abs(r - segR));
    float gAmt = (.16 + .5 * h + .45 * o) * (fresh ? 1.3 : .8) * lvl;
    if (uTier > 3.5 && uMoving > .5 && uFx >= 2.) gAmt *= .85 + .3 * sin(uTime * (7. + 6. * o));
    vec3 gc = heat(uu);
    glow(dark ? gc : ink(gc), g * gAmt * (dark ? .55 : .22));
  }

  // tier tick dots
  for (int t = 0; t < 4; t++) {
    if (thumbnail) break;
    float th = uTicks[t];
    float ta = radians(135. + th * 270.);
    vec2 tp = vec2(cos(ta), -sin(ta)) * .463;
    float on = step(th, h + .0005);
    vec3 tc = on > .5 ? (dark ? heat(th) : ink(heat(th))) : (dark ? vec3(1.) : vec3(0.));
    paint(tc, smoothstep(.0072, .0042, length(p - tp)) * (on > .5 ? .95 : .2));
  }

  // tip flare
  if (!thumbnail && h > .02) {
    float ta = radians(135. + min(h * uSweep, 1.) * 270.);
    vec2 tp = vec2(cos(ta), -sin(ta)) * segR;
    vec2 d = p - tp;
    vec2 tang = vec2(-sin(ta), -cos(ta));
    vec2 rad = normalize(tp);
    float bloom = exp(-length(d) / (.01 + .016 * h));
    glow(dark ? HOT : hcI, bloom * (.3 + .35 * h) * (dark ? 1. : .5));
    if (fresh && motion) {
      float star = exp(-abs(dot(d, tang)) / (.05 + .16 * o)) * exp(-abs(dot(d, rad)) / .0032)
                 + exp(-abs(dot(d, rad)) / (.035 + .09 * o)) * exp(-abs(dot(d, tang)) / .0028);
      float fAmt = smoothstep(.5, .85, h) * (.55 + .9 * o) * lvl;
      glow(dark ? HOT : hcI, star * fAmt * (dark ? .9 : .4));
    }
  }

  // comets
  if (!thumbnail && h > .01 && uFx > .5 && uMoving > .5) {
    int nC = (fresh && motion && h > .55) ? 2 : 1;
    for (int c = 0; c < 2; c++) {
      if (c >= nC) break;
      float head = mod(uComet * 360. + float(c) * 180., 360.);
      float behind = mod(head - ang + 360., 360.);
      float tail = fresh ? 40. + 60. * h : 40.;
      float rc = .455;
      float band = exp(-pow((r - rc) / (.0035 + .0045 * h), 2.));
      float along = clamp(1. - behind / tail, 0., 1.);
      float cA = step(behind, tail) * along * along * band;
      float hr = radians(head);
      float headGlow = exp(-length(p - vec2(cos(hr), -sin(hr)) * rc) / (.01 + .006 * h));
      float op = (.25 + .6 * h) * (c == 1 ? .7 : 1.);
      vec3 cc = mix(hc, HOT, along);
      glow(dark ? cc : ink(hc), (cA + headGlow * .9) * op * (dark ? 1. : .6));
    }
  }

  // shockwaves
  for (int i = 0; i < 4; i++) {
    vec4 w = uWaves[i];
    if (w.x < 0. || w.x > 1.) continue;
    float rr = .5 + .24 * easeOut(w.x);
    float wid = (.005 + .005 * w.y) * (1. - w.x) + .001;
    float ring = exp(-pow((r - rr) / wid, 2.)) * (1. - w.x) * .7 * w.y;
    vec3 wc = mix(heat(w.z), HOT, .3);
    glow(dark ? wc : ink(heat(w.z)), ring * (dark ? 1. : .6));
    if (fresh) {
      float rr2 = .5 + .16 * easeOut(w.x * 1.3);
      glow(dark ? heat(w.z) : ink(heat(w.z)), exp(-pow((r - rr2) / (wid * 3.5), 2.)) * (1. - w.x) * .3 * w.y);
    }
  }

  // new peak: the whole disc flashes and a gold ring blows outward
  if (uPeak < 1.4) {
    float f = exp(-uPeak * 4.5);
    glow(dark ? HOT : vec3(1., .69, .13), f * (dark ? .75 : .35) * smoothstep(.6, .15, r));
    float ringR = .5 + .24 * easeOut(uPeak / 1.4);
    glow(vec3(1., .78, .3), exp(-pow((r - ringR) / (.012 + .02 * uPeak), 2.)) * (1. - uPeak / 1.4) * (fresh ? 1. : .5));
  }

  acc *= smoothstep(.74, .73, r);
  outColor = acc.a < .0005 ? vec4(0.) : acc;
}`;
