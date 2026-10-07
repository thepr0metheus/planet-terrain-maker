// The picture on top of a model, in a style: the photo as it is, contour lines over the colours of
// height, watercolour, painterly (a Kuwahara filter), a pencil sketch (XDoG) or three tones; and
// the water below a level, coloured by its depth. Drawn by the graphics card (WebGL 2) into a
// picture of the photo's size, which the view lays on the model and the files carry.
//
// The heights go to the card as they are (float32), and are read between their cells by the
// shader itself: a float texture that the card blends needs an extension many phones lack.

import { HeightGrid } from './height-grid.js';

export const STYLES = ['photo', 'contours', 'watercolor', 'painterly', 'pencil', 'tritone'];

// The graphics card draws a style at most this big: a picture of 8192 points takes several
// pictures of its size on the card (blurs, passes), more memory than many cards give a page.
export const PAINT_MOST_PX = 4096;

// Whether a picture needs the graphics card at all: the photo as it is, without water, does not.
export function needsPainting(style, options = {}, water = null) {
  if (style !== 'photo' || water?.on) return true;
  return (options.brightness ?? 0) !== 0 || (options.contrast ?? 1) !== 1 || (options.saturation ?? 1) !== 1;
}

export const TRITONES = {
  dusk: ['#1d2b53', '#c06c84', '#f8b195'],
  sepia: ['#2b1d0e', '#8c5a2b', '#f3e2c7'],
  atlas: ['#14313d', '#4f8a8b', '#f4e3b1'],
  ink: ['#0e1424', '#5b6478', '#f2efe6'],
};

// A step for contour lines that gives about `lines` lines over `range` metres: 1, 2 or 5 times a
// power of ten.
export function niceStep(range, lines = 14) {
  const raw = Math.max(range, 1e-6) / lines;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uPx;                  // one pixel, in uv
uniform sampler2D uHeights;        // float32, one value a texel, read with texelFetch
uniform vec2 uHeightsSize;
uniform vec2 uMetres;              // the frame's ground width and height
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float heightAt(vec2 uv) {
  vec2 p = clamp(uv, 0.0, 1.0) * (uHeightsSize - 1.0);
  ivec2 i = ivec2(floor(p));
  ivec2 j = min(i + 1, ivec2(uHeightsSize) - 1);
  vec2 f = p - vec2(i);
  float a = texelFetch(uHeights, i, 0).r, b = texelFetch(uHeights, ivec2(j.x, i.y), 0).r;
  float c = texelFetch(uHeights, ivec2(i.x, j.y), 0).r, d = texelFetch(uHeights, j, 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// The light on the ground from the sun: 0 in full shade, 1 facing the sun.
uniform vec3 uSun;
uniform float uRelief;              // how much the shade shows the relief
float shade(vec2 uv) {
  vec2 step = 1.0 / (uHeightsSize - 1.0);
  float dx = (heightAt(uv + vec2(step.x, 0.0)) - heightAt(uv - vec2(step.x, 0.0))) / (2.0 * step.x * uMetres.x);
  float dy = (heightAt(uv + vec2(0.0, step.y)) - heightAt(uv - vec2(0.0, step.y))) / (2.0 * step.y * uMetres.y);
  // v grows southwards: north is -dy
  vec3 n = normalize(vec3(-dx * uRelief, dy * uRelief, 1.0));
  return clamp(dot(n, uSun), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
`;

const SHADERS = {
  copy: `void main() { outColor = texture(uSrc, vUv); }`,

  // One direction of a Gaussian blur; run twice, across and down.
  blur: `uniform vec2 uDir; uniform float uSigma;
  void main() {
    vec4 sum = vec4(0.0); float total = 0.0;
    for (int i = -14; i <= 14; i++) {
      float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
      sum += texture(uSrc, vUv + uDir * float(i)) * w; total += w;
    }
    outColor = sum / total;
  }`,

  photo: `uniform float uBright; uniform float uContrast; uniform float uSaturation;
  void main() {
    vec3 c = texture(uSrc, vUv).rgb;
    c = (c - 0.5) * uContrast + 0.5 + uBright;
    c = mix(vec3(luma(c)), c, uSaturation);
    outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`,

  contours: `uniform float uStep; uniform float uLow; uniform float uHigh; uniform float uPhoto; uniform float uLineScale;
  vec3 ramp(float t) {
    vec3 a = vec3(0.32, 0.50, 0.33), b = vec3(0.70, 0.75, 0.47), c = vec3(0.86, 0.76, 0.52), d = vec3(0.66, 0.50, 0.38), e = vec3(0.96, 0.95, 0.93);
    if (t < 0.25) return mix(a, b, t / 0.25);
    if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
    if (t < 0.8) return mix(c, d, (t - 0.5) / 0.3);
    return mix(d, e, (t - 0.8) / 0.2);
  }
  void main() {
    float h = heightAt(vUv);
    float t = clamp((h - uLow) / max(uHigh - uLow, 1e-3), 0.0, 1.0);
    vec3 base = mix(ramp(t), texture(uSrc, vUv).rgb, uPhoto);
    base *= 0.55 + 0.6 * shade(vUv);
    float s = h / uStep;
    float d = abs(fract(s - 0.5) - 0.5) / max(fwidth(s), 1e-4);
    float index = step(abs(mod(floor(s + 0.5), 5.0)), 0.5);
    // lines a few pixels wide: the picture is seen smaller than it is, and thin lines would vanish
    float width = mix(0.9, 1.8, index) * uLineScale;
    float line = 1.0 - smoothstep(width - 0.5, width + 0.5, d);
    vec3 ink = vec3(0.30, 0.20, 0.12);
    outColor = vec4(mix(base, ink, line * mix(0.55, 0.85, index)), 1.0);
  }`,

  // uSrc: the photo blurred a little; uSrc2: blurred more.
  watercolor: `uniform sampler2D uSrc2;
  void main() {
    vec3 soft = texture(uSrc, vUv).rgb, wide = texture(uSrc2, vUv).rgb;
    vec3 c = floor(soft * 7.0 + 0.5) / 7.0;
    c = mix(soft, c, 0.55);
    c = mix(vec3(luma(c)), c, 1.25);
    float edge = clamp(length(soft - wide) * 3.0, 0.0, 1.0);
    float paper = noise(vUv / uPx * 0.35) * 0.6 + noise(vUv / uPx * 0.07) * 0.4;
    float bloom = noise(vUv / uPx * 0.012);
    c = mix(c, vec3(0.97, 0.95, 0.90), 0.18 + 0.12 * bloom);
    c *= 1.0 - 0.32 * edge;
    c *= 0.9 + 0.12 * paper;
    outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`,

  // The generalized Kuwahara filter with four square sectors: each pixel takes the mean of the
  // sector around it whose colours vary least.
  painterly: `uniform float uRadius;
  void main() {
    vec3 mean[4]; vec3 sq[4];
    for (int k = 0; k < 4; k++) { mean[k] = vec3(0.0); sq[k] = vec3(0.0); }
    int r = int(uRadius);
    float n = float((r + 1) * (r + 1));
    for (int j = 0; j <= 8; j++) {
      if (j > r) break;
      for (int i = 0; i <= 8; i++) {
        if (i > r) break;
        vec3 c0 = texture(uSrc, vUv + uPx * vec2(-i, -j)).rgb;
        vec3 c1 = texture(uSrc, vUv + uPx * vec2(i, -j)).rgb;
        vec3 c2 = texture(uSrc, vUv + uPx * vec2(-i, j)).rgb;
        vec3 c3 = texture(uSrc, vUv + uPx * vec2(i, j)).rgb;
        mean[0] += c0; sq[0] += c0 * c0; mean[1] += c1; sq[1] += c1 * c1;
        mean[2] += c2; sq[2] += c2 * c2; mean[3] += c3; sq[3] += c3 * c3;
      }
    }
    float best = 1e9; vec3 colour = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      vec3 m = mean[k] / n;
      vec3 v = abs(sq[k] / n - m * m);
      float s = v.r + v.g + v.b;
      if (s < best) { best = s; colour = m; }
    }
    colour = mix(vec3(luma(colour)), colour, 1.15);
    outColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
  }`,

  // Extended difference of Gaussians on the brightness: uSrc blurred by sigma, uSrc2 by 1.6 sigma.
  pencil: `uniform sampler2D uSrc2; uniform float uTau; uniform float uPhi;
  void main() {
    float g1 = luma(texture(uSrc, vUv).rgb), g2 = luma(texture(uSrc2, vUv).rgb);
    float d = g1 - uTau * g2;
    float e = d >= 0.0 ? 1.0 : 1.0 + tanh(uPhi * d);
    float tone = mix(0.62, 1.0, smoothstep(0.15, 0.85, shade(vUv)));
    float grain = noise(vUv / uPx * 0.9) * 0.08 + noise(vUv / uPx * 0.2) * 0.06;
    float hatch = 0.5 + 0.5 * sin((vUv.x + vUv.y) / uPx.x * 0.9);
    float dark = (1.0 - tone) * smoothstep(0.35, 1.0, hatch);
    float g = clamp(e - dark * 0.35 - grain, 0.0, 1.0);
    vec3 paper = vec3(0.97, 0.96, 0.92), graphite = vec3(0.17, 0.18, 0.21);
    outColor = vec4(mix(graphite, paper, g), 1.0);
  }`,

  tritone: `uniform vec3 uDark; uniform vec3 uMid; uniform vec3 uLight;
  void main() {
    float l = luma(texture(uSrc, vUv).rgb);
    l = smoothstep(0.05, 0.95, l);
    vec3 c = l < 0.5 ? mix(uDark, uMid, l * 2.0) : mix(uMid, uLight, (l - 0.5) * 2.0);
    outColor = vec4(c, 1.0);
  }`,

  // Water below a level, coloured by its depth; the shore drawn smooth.
  water: `uniform float uLevel; uniform float uDeep;
  void main() {
    vec3 base = texture(uSrc, vUv).rgb;
    float depth = uLevel - heightAt(vUv);
    float wet = clamp(depth / max(fwidth(depth), 1e-4) + 0.5, 0.0, 1.0);
    vec3 shallow = vec3(0.45, 0.72, 0.84), deep = vec3(0.09, 0.27, 0.45);
    vec3 water = mix(shallow, deep, clamp(depth / max(uDeep, 1e-3), 0.0, 1.0));
    water += (noise(vUv / uPx * 0.05) - 0.5) * 0.04;
    outColor = vec4(mix(base, water, wet * 0.9), 1.0);
  }`,
};

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

export class StylePainter {
  constructor() {
    this._canvas = document.createElement('canvas');
    this._gl = this._canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    this._programs = {};
    if (!this._gl) return;
    const gl = this._gl;
    this._quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  }

  get works() { return Boolean(this._gl); }

  // The picture in a style, as a new canvas. picture: the photo (canvas). heights: HeightGrid over
  // the same ground. metres: { widthM, heightM } of that ground. options: the style's own.
  // water: { on, levelM } or null. sun: { azimuthDeg, elevationDeg }.
  paint({ picture, heights, metres, style = 'photo', options = {}, water = null, sun = { azimuthDeg: 315, elevationDeg: 40 } }) {
    if (!this.works) throw new Error('This browser has no WebGL 2: styles are off.');
    const gl = this._gl;
    const shrink = Math.min(1, PAINT_MOST_PX / Math.max(picture.width, picture.height));
    if (shrink < 1) {
      const smaller = document.createElement('canvas');
      smaller.width = Math.round(picture.width * shrink);
      smaller.height = Math.round(picture.height * shrink);
      smaller.getContext('2d').drawImage(picture, 0, 0, smaller.width, smaller.height);
      picture = smaller;
    }
    const w = picture.width, h = picture.height;
    this._canvas.width = w;
    this._canvas.height = h;
    gl.viewport(0, 0, w, h);
    const src = this._texture(picture);
    const heightsTex = this._heightsTexture(heights);
    const range = heights.range();
    const az = sun.azimuthDeg * Math.PI / 180, el = sun.elevationDeg * Math.PI / 180;
    const common = {
      uPx: [1 / w, 1 / h], uHeights: heightsTex, uHeightsSize: [heights.cols, heights.rows],
      uMetres: [metres.widthM, metres.heightM],
      uSun: [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)],
      uRelief: options.relief ?? 1.5,
    };
    const made = [];
    const target = () => {
      const t = this._blank(w, h);
      made.push(t);
      return t;
    };
    const blurred = (from, sigma) => {
      const across = target(), down = target();
      this._run('blur', { ...common, uSrc: from.texture, uDir: [1 / w, 0], uSigma: sigma }, across);
      this._run('blur', { ...common, uSrc: across.texture, uDir: [0, 1 / h], uSigma: sigma }, down);
      return down;
    };
    let out = target();
    const photo = { texture: src };
    switch (style) {
      case 'contours':
        this._run('contours', {
          ...common, uSrc: src, uStep: options.stepM || niceStep(range.highest - range.lowest),
          uLow: range.lowest, uHigh: range.highest, uPhoto: options.overPhoto ? 0.55 : 0, uLineScale: Math.max(1, w / 1024),
        }, out);
        break;
      case 'watercolor': {
        const soft = blurred(photo, Math.max(1.2, w / 900)), wide = blurred(photo, Math.max(4, w / 260));
        this._run('watercolor', { ...common, uSrc: soft.texture, uSrc2: wide.texture }, out);
        break;
      }
      case 'painterly':
        this._run('painterly', { ...common, uSrc: src, uRadius: Math.min(8, Math.max(3, Math.round(w / 420))) }, out);
        break;
      case 'pencil': {
        const sigma = Math.max(0.9, w / 1600);
        const g1 = blurred(photo, sigma), g2 = blurred(photo, sigma * 1.6);
        this._run('pencil', { ...common, uSrc: g1.texture, uSrc2: g2.texture, uTau: 0.985, uPhi: 120 }, out);
        break;
      }
      case 'tritone': {
        const [dark, mid, light] = (TRITONES[options.palette] ?? TRITONES.dusk).map(hexRgb);
        this._run('tritone', { ...common, uSrc: src, uDark: dark, uMid: mid, uLight: light }, out);
        break;
      }
      default:
        this._run('photo', {
          ...common, uSrc: src, uBright: options.brightness ?? 0, uContrast: options.contrast ?? 1, uSaturation: options.saturation ?? 1,
        }, out);
    }
    if (water?.on) {
      const wet = target();
      this._run('water', { ...common, uSrc: out.texture, uLevel: water.levelM, uDeep: Math.max(20, (range.highest - range.lowest) * 0.15) }, wet);
      out = wet;
    }
    const result = this._read(out, w, h);
    for (const t of made) { gl.deleteFramebuffer(t.framebuffer); gl.deleteTexture(t.texture); }
    gl.deleteTexture(src);
    gl.deleteTexture(heightsTex);
    return result;
  }

  _program(name) {
    if (this._programs[name]) return this._programs[name];
    const gl = this._gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`${name}: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, COMMON + SHADERS[name]));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(program)}`);
    this._programs[name] = program;
    return program;
  }

  _run(name, uniforms, into) {
    const gl = this._gl;
    const program = this._program(name);
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    const at = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    let unit = 0;
    for (const [key, value] of Object.entries(uniforms)) {
      const loc = gl.getUniformLocation(program, key);
      if (loc === null) continue;
      if (value instanceof WebGLTexture) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value);
        gl.uniform1i(loc, unit);
        unit += 1;
      } else if (Array.isArray(value)) {
        gl[`uniform${value.length}fv`](loc, value);
      } else {
        gl.uniform1f(loc, value);
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _texture(picture) {
    const gl = this._gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, picture);
    this._linear(texture);
    return texture;
  }

  _heightsTexture(heights) {
    const gl = this._gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const data = heights instanceof HeightGrid ? heights.data : heights;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, heights.cols, heights.rows, 0, gl.RED, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  _linear(texture) {
    const gl = this._gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _blank(w, h) {
    const gl = this._gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this._linear(texture);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, framebuffer };
  }

  _read(target, w, h) {
    const gl = this._gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    const pixels = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0);
    return out;
  }
}
