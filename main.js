import "./style.css";

import { init } from "gmp-wasm";

import { getCursorPos, initShaderProgram, createMatrices } from "./glutils.js";

init().then(({ binding }) => {
  fetch("https://apj.hgreer.com/mandeljs", {
    method: "GET", // or 'POST' if needed
    cache: "no-store",
    mode: "no-cors",
  });
  // No further handling of the response or errors

  const DEBUG = false;
  const dbg = (...args) => DEBUG && console.log(...args);
  const INTERACTION_DEBUG = true;
  const idbg = (...args) => INTERACTION_DEBUG && console.log("[interaction]", ...args);
  dbg(binding);

  function mpfr_make(prec = 1200) {
    const x = binding.mpfr_t();
    if (binding.mpfr_init2) {
      binding.mpfr_init2(x, prec);
    } else {
      // Fallback if init2 isn't exposed by the WASM binding
      binding.mpfr_init_set_d(x, 0, 0);
      binding.mpfr_set_prec(x, prec);
    }
    binding.mpfr_set_d(x, 0, 0);
    return x;
  }

  // Backwards-compatible alias (many callsites currently use this name)
  function mpfr_zero() {
    return mpfr_make(1200);
  }
  
  // Higher precision for center coordinates to handle extreme zoom levels
  function mpfr_zero_high_prec() {
    return mpfr_make(2000);
  }

  // Reused temporaries (avoid allocating mpfr_t in hot paths)
  // Use higher precision for panning temporaries to handle extreme zoom levels
  const tmp_log2 = mpfr_make(1200);
  const tmp_update_mx = mpfr_make(2000);
  const tmp_update_my = mpfr_make(2000);
  const tmp_zoom_delta = mpfr_make(1200);
  const tmp_zoom_shift_x = mpfr_make(1200);
  const tmp_zoom_shift_y = mpfr_make(1200);

  let mandelbrot_state = {
    center: [mpfr_zero_high_prec(), mpfr_zero_high_prec()],
    radius: mpfr_zero(),
    iterations: 1000,
    cmapscale: 20,
    callbacks: [],
    modified: function () {
      for (const cb of this.callbacks) {
        cb();
      }
    },
    set: function (x, y, r) {
      binding.mpfr_set_d(this.center[0], x, 0);
      binding.mpfr_set_d(this.center[1], y, 0);
      binding.mpfr_set_d(this.radius, r, 0);
      this.modified();
    },
    update: function (dx, dy) {
      binding.mpfr_mul_d(tmp_update_mx, this.radius, dx, 0);
      binding.mpfr_mul_d(tmp_update_my, this.radius, -dy, 0);

      binding.mpfr_mul_d(this.radius, this.radius, 1.0 / 2.0, 0);

      binding.mpfr_add(this.center[0], this.center[0], tmp_update_mx, 0);
      binding.mpfr_add(this.center[1], this.center[1], tmp_update_my, 0);

      this.modified();
    },
    pan: function (dx, dy) {
      // At extreme zoom levels, ensure we have sufficient precision for panning
      binding.mpfr_mul_d(tmp_update_mx, this.radius, dx, 0);
      binding.mpfr_mul_d(tmp_update_my, this.radius, -dy, 0);

      // Use MPFR's rounding mode 0 (nearest) for maximum precision
      binding.mpfr_add(this.center[0], this.center[0], tmp_update_mx, 0);
      binding.mpfr_add(this.center[1], this.center[1], tmp_update_my, 0);

      this.modified();
    },
    zoomAt: function (factor, ndcX, ndcY) {
      if (!isFinite(factor) || factor <= 0) return;
      if (!isFinite(ndcX) || !isFinite(ndcY)) return;

      // Keep the complex-plane point under (ndcX, ndcY) fixed while scaling radius:
      // center' = center + radius*(1 - factor) * (ndcX, -ndcY)
      binding.mpfr_mul_d(tmp_zoom_delta, this.radius, 1 - factor, 0);
      binding.mpfr_mul_d(tmp_zoom_shift_x, tmp_zoom_delta, ndcX, 0);
      binding.mpfr_mul_d(tmp_zoom_shift_y, tmp_zoom_delta, -ndcY, 0);

      binding.mpfr_add(this.center[0], this.center[0], tmp_zoom_shift_x, 0);
      binding.mpfr_add(this.center[1], this.center[1], tmp_zoom_shift_y, 0);
      binding.mpfr_mul_d(this.radius, this.radius, factor, 0);

      this.modified();
    },
  };
  function get_cookie(cookie, key) {
    var cookieValue = cookie.replace(/\s+/g, "").split(";");

    cookieValue = cookieValue.find((row) => row.startsWith(key + "="))?.split("=")[1];

    return cookieValue;
  }
  if (document.cookie.length > 30) {
    binding.mpfr_set_string(mandelbrot_state.center[0], get_cookie(document.cookie, "x"), 10, 0);
    binding.mpfr_set_string(mandelbrot_state.center[1], get_cookie(document.cookie, "y"), 10, 0);
    binding.mpfr_set_string(mandelbrot_state.radius, get_cookie(document.cookie, "radius"), 10, 0);
  } else {
    binding.mpfr_set_string(mandelbrot_state.center[0], "0", 10, 0);
    binding.mpfr_set_string(mandelbrot_state.center[1], "0", 10, 0);
    binding.mpfr_set_string(mandelbrot_state.radius, "2", 10, 0);
  }
  main();
  function main() {
    document.querySelector("#reset").addEventListener("click", () => {
      document.querySelector("#iterations").value = "1000";
      document.querySelector("#cmapscale").value = "20.1";
      mandelbrot_state.iterations = 1000;
      mandelbrot_state.cmapscale = 20.1;
      mandelbrot_state.set(0, 0, 2);
    });
    document.querySelector("#out").addEventListener("click", () => {
      binding.mpfr_mul_d(mandelbrot_state.radius, mandelbrot_state.radius, 2, 0);
      mandelbrot_state.modified();
    });
    const maxWidth = Math.min(window.innerWidth, 700);
    const canvasSize = Math.min(maxWidth, window.innerHeight);

    const canvas = document.querySelector("#canvas");
    canvas.width = canvasSize;
    canvas.height = canvasSize;

    // ----- Controls: wheel zoom + drag pan + pinch zoom (Pointer Events) -----
    canvas.style.cursor = "grab";

    function pxToNdc(px, py) {
      const ndcX = px / (canvasSize / 2) - 1;
      const ndcY = py / (canvasSize / 2) - 1;
      return [ndcX, ndcY];
    }

    function getEventNdc(ev) {
      const [px, py] = getCursorPos(canvas, ev);
      return pxToNdc(px, py);
    }

    function deltaPxToNdc(dxPx, dyPx) {
      return [dxPx / (canvasSize / 2), dyPx / (canvasSize / 2)];
    }

    function normalizedWheelDelta(ev) {
      // Convert delta to roughly "pixels" (trackpad) regardless of deltaMode.
      let dy = ev.deltaY;
      if (ev.deltaMode === 1) dy *= 16; // lines -> px-ish
      else if (ev.deltaMode === 2) dy *= canvasSize; // pages -> big step
      return dy;
    }

    // Coalesce wheel events into one zoom per animation frame (prevents "jumping" on trackpads).
    let wheelPendingDy = 0;
    let wheelLastNdc = [0, 0];
    let wheelRaf = 0;
    function applyWheelZoom() {
      wheelRaf = 0;
      const dy = wheelPendingDy;
      wheelPendingDy = 0;

      // dy > 0 => zoom out (radius larger). dy < 0 => zoom in (radius smaller).
      // Use a conservative speed and clamp the per-frame zoom amount to avoid sudden jumps.
      const speed = 0.0012;
      let factor = Math.exp(dy * speed);
      factor = Math.min(2.0, Math.max(0.5, factor));
      idbg("wheel/apply", { dy, factor, ndc: wheelLastNdc.slice() });
      mandelbrot_state.zoomAt(factor, wheelLastNdc[0], wheelLastNdc[1]);
    }

    canvas.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        noteInteraction();
        idbg("wheel/event", { deltaY: ev.deltaY, deltaMode: ev.deltaMode });
        wheelLastNdc = getEventNdc(ev);

        let dy = normalizedWheelDelta(ev);
        // Clamp each event so weird devices / momentum can't enqueue huge jumps.
        dy = Math.min(200, Math.max(-200, dy));
        wheelPendingDy += dy;

        if (!wheelRaf) wheelRaf = requestAnimationFrame(applyWheelZoom);
      },
      { passive: false },
    );

    canvas.addEventListener(
      "dblclick",
      (ev) => {
        ev.preventDefault();
        noteInteraction();
        idbg("dblclick", { ndc: getEventNdc(ev) });
        const [ndcX, ndcY] = getEventNdc(ev);
        mandelbrot_state.zoomAt(0.5, ndcX, ndcY);
      },
      { passive: false },
    );

    canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

    const pointers = new Map(); // id -> {x, y} in canvas px
    let dragPointerId = null;
    let lastDragPx = null;
    let pinch = null; // { idA, idB, lastDist, lastMid: {x,y} }

    function getPxFromPointerEvent(ev) {
      const [px, py] = getCursorPos(canvas, ev);
      return { x: px, y: py };
    }

    function tryStartGesture() {
      if (pointers.size === 1) {
        // Drag
        pinch = null;
        dragPointerId = pointers.keys().next().value;
        lastDragPx = pointers.get(dragPointerId);
        canvas.style.cursor = "grabbing";
        idbg("gesture", { mode: "drag", pointers: pointers.size });
      } else if (pointers.size >= 2) {
        // Pinch (use the first two pointers)
        dragPointerId = null;
        lastDragPx = null;
        canvas.style.cursor = "grabbing";

        const ids = Array.from(pointers.keys()).slice(0, 2);
        const a = pointers.get(ids[0]);
        const b = pointers.get(ids[1]);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1;
        pinch = {
          idA: ids[0],
          idB: ids[1],
          lastDist: dist,
          lastMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        idbg("gesture", { mode: "pinch", pointers: pointers.size });
      } else {
        pinch = null;
        dragPointerId = null;
        lastDragPx = null;
        canvas.style.cursor = "grab";
        idbg("gesture", { mode: "none", pointers: pointers.size });
      }
    }

    canvas.addEventListener("pointerdown", (ev) => {
      // Avoid browser gesture handling; we handle all panning/zooming ourselves.
      ev.preventDefault();
      noteInteraction();
      interactionHold = true;
      interactionItersLocked = null;
      interactionKeyLocked = null;
      idbg("pointerdown", { id: ev.pointerId, type: ev.pointerType });
      canvas.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, getPxFromPointerEvent(ev));
      tryStartGesture();
    });

    canvas.addEventListener("pointermove", (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, getPxFromPointerEvent(ev));
      noteInteraction();
      // Avoid spam: only log if in drag or pinch mode, but still once per event.
      idbg("pointermove", { id: ev.pointerId, pointers: pointers.size, pinch: !!pinch });

      if (pinch && pointers.has(pinch.idA) && pointers.has(pinch.idB)) {
        const a = pointers.get(pinch.idA);
        const b = pointers.get(pinch.idB);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

        // Pan with midpoint motion (grab-and-move)
        const [midDxNdc, midDyNdc] = deltaPxToNdc(mid.x - pinch.lastMid.x, mid.y - pinch.lastMid.y);
        mandelbrot_state.pan(-midDxNdc, -midDyNdc);

        // Zoom with distance change around the midpoint
        const factor = pinch.lastDist / dist;
        const [midNdcX, midNdcY] = pxToNdc(mid.x, mid.y);
        mandelbrot_state.zoomAt(Math.min(10, Math.max(0.1, factor)), midNdcX, midNdcY);

        pinch.lastDist = dist;
        pinch.lastMid = mid;
        return;
      }

      if (dragPointerId != null && ev.pointerId === dragPointerId && lastDragPx) {
        const cur = pointers.get(dragPointerId);
        const [dxNdc, dyNdc] = deltaPxToNdc(cur.x - lastDragPx.x, cur.y - lastDragPx.y);
        // Drag right => move view left (grab the fractal)
        mandelbrot_state.pan(-dxNdc, -dyNdc);
        lastDragPx = cur;
      }
    });

    function endPointer(ev) {
      if (pointers.has(ev.pointerId)) pointers.delete(ev.pointerId);
      noteInteraction();
      interactionHold = pointers.size > 0;
      if (!interactionHold) {
        interactionItersLocked = null;
        interactionKeyLocked = null;
      }
      idbg("pointerend", { id: ev.pointerId, pointers: pointers.size, hold: interactionHold });
      tryStartGesture();
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    document.querySelector("#iterations").addEventListener("input", (event) => {
      mandelbrot_state.iterations = parseInt(event.target.value);
      mandelbrot_state.modified();
    });
    document.querySelector("#cmapscale").addEventListener("input", (event) => {
      mandelbrot_state.cmapscale = parseFloat(event.target.value);
      mandelbrot_state.modified();
    });
    function updateFromClickpos() {
      var text = document.querySelector("#clickpos").value;
      dbg("clickpos", text);
      binding.mpfr_set_string(mandelbrot_state.center[0], get_cookie(text, "re"), 10, 0);
      binding.mpfr_set_string(mandelbrot_state.center[1], get_cookie(text, "im"), 10, 0);
      binding.mpfr_set_string(mandelbrot_state.radius, get_cookie(text, "r"), 10, 0);

      if (+get_cookie(text, "iterations")) {
        mandelbrot_state.iterations = +get_cookie(text, "iterations");
      }
      binding.mpfr_log2(tmp_log2, mandelbrot_state.radius, 0);
      var exp = binding.mpfr_get_exp(mandelbrot_state.radius);

      var logfloat = binding.mpfr_get_d(tmp_log2, 0);
      dbg("radius log2", logfloat, "exp", exp);
      dbg("r", get_cookie(text, "r"));
      dbg(mandelbrot_state);
      mandelbrot_state.modified();
      dbg(mandelbrot_state);
      dbg("blur");
    }
    document.querySelector("#clickpos").addEventListener("blur", updateFromClickpos);
    document.getElementById("clickpos").onPaste = updateFromClickpos;

    // Debounce persistence/UI updates so drag/wheel stay responsive.
    let persistTimer = null;
    function persistStateToUiAndUrl() {
      let x_str = binding.mpfr_to_string(mandelbrot_state.center[0], 10, 0, false);
      let y_str = binding.mpfr_to_string(mandelbrot_state.center[1], 10, 0, false);
      let radius_str = binding.mpfr_to_string(mandelbrot_state.radius, 10, 0, false);

      document.cookie = "x=" + x_str + ";max-age=31536000";
      document.cookie = "y=" + y_str + ";max-age=31536000";
      document.cookie = "radius=" + radius_str + ";max-age=31536000";
      //fetch(
      // "https://apj.hgreer.com/mandel/?real=" + x_str + "&imag=" + y_str + "&radius=" + radius_str,
      //  {
      //   method: "GET", 
      //   cache: "no-store",
      //   mode: "no-cors",
      //});
      function clip(str) {
        var l = 10 + radius_str.replace(/0+\d$/, "").split("0").length;
        return str.slice(0, l);
      }

      const locationString =
        "re=" +
        clip(x_str) +
        "; im=" +
        clip(y_str) +
        "; r=" +
        clip(radius_str) +
        "; iterations=" +
        mandelbrot_state.iterations;

      document.querySelector("#clickpos").value = locationString;

      // Store location in URL (uncompressed, original format)
      window.history.replaceState(
        null,
        document.title,
        "/?;" + locationString.replace(/ /g, ""),
      );
      
      // Update scale display (scale = 2/radius, since radius=2 is 1x zoom)
      const radius = binding.mpfr_get_d(mandelbrot_state.radius, 0);
      const scale = 2.0 / radius;
      let scaleDisplay = "";
      if (scale >= 1e9) {
        scaleDisplay = scale.toExponential(2) + "x";
      } else if (scale >= 1e6) {
        scaleDisplay = (scale / 1e6).toFixed(2) + "Mx";
      } else if (scale >= 1e3) {
        scaleDisplay = (scale / 1e3).toFixed(2) + "Kx";
      } else {
        scaleDisplay = scale.toFixed(2) + "x";
      }
      const scaleElement = document.querySelector("#scale-display");
      if (scaleElement) {
        scaleElement.textContent = "Scale: " + scaleDisplay;
      }
    }
    mandelbrot_state.callbacks.push(() => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(persistStateToUiAndUrl, 150);
    });
    
    // Initialize scale display
    persistStateToUiAndUrl();
    // Disable default framebuffer MSAA so we can blit our low-res interaction FBO without
    // hitting "Invalid operation on multisampled framebuffer" on platforms that enable MSAA by default.
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      alert("Unable to initialize WebGL. Your browser or machine may not support it.");
      return;
    }
    const vsSource = `#version 300 es
in vec4 aVertexPosition;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
out highp vec2 delta;
void main() {
  gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
  delta = vec2(aVertexPosition[0], aVertexPosition[1]);
}
  `;
    const fsSource = `#version 300 es
precision highp float;
in highp vec2 delta;
out vec4 fragColor;
uniform vec4 uState;
uniform float uTargetIters;
uniform vec2 uCenterDelta;
uniform vec4 poly1;
uniform vec4 poly2;
uniform sampler2D sequence;
float exp2_clamped(float e) {
  e = clamp(e, -126.0, 126.0);
  return exp2(e);
}
// Orbit is packed as RGBA32F texels: (x, y, scale, unused)
vec3 get_orbit(int i) {
  int row = i / 1024;
  int col = i - row * 1024;
  vec4 t = texelFetch(sequence, ivec2(col, row), 0);
  return t.xyz;
}
void main() {
  float q = uState[2] - 1.0;
  float cq = q;
  q = q + poly2[3];
  float S = exp2_clamped(q);
  vec2 d = delta + uCenterDelta;
  float dcx = d.x;
  float dcy = d.y;
  float x;
  float y;
  // dx + dyi = (p0 + p1 i) * (dcx, dcy) + (p2 + p3i) * (dcx + dcy * i) * (dcx + dcy * i)
  float sqrx =  (dcx * dcx - dcy * dcy);
  float sqry =  (2. * dcx * dcy);

  float cux =  (dcx * sqrx - dcy * sqry);
  float cuy =  (dcx * sqry + dcy * sqrx);
  float dx = poly1[0]  * dcx - poly1[1] *  dcy + poly1[2] * sqrx - poly1[3] * sqry ;// + poly2[0] * cux - poly2[1] * cuy;
  float dy = poly1[0] *  dcy + poly1[1] *  dcx + poly1[2] * sqry + poly1[3] * sqrx ;//+ poly2[0] * cuy + poly2[1] * cux;
      
  int k = int(poly2[2]);

  if (false) {
      q = cq;
      dx = 0.;
      dy = 0.;
      k = 0;
  }
  int j = k;
  vec3 orb = get_orbit(k);
  x = orb.x;
  y = orb.y;
  float os_prev = orb.z;
  
  for (int i = k; float(i) < uState[3]; i++){
    j += 1;
    k += 1;
    float os = os_prev;
    dcx = d.x * exp2_clamped(-q + cq - os);
    dcy = d.y * exp2_clamped(-q + cq - os);
    float unS = exp2_clamped(q - os);

    if (isinf(unS)) {
    unS = 0.;
      }

    float tx = 2. * x * dx - 2. * y * dy + unS  * dx * dx - unS * dy * dy + dcx;
    dy = 2. * x * dy + 2. * y * dx + unS * 2. * dx * dy +  dcy;
    dx = tx;

    q = q + os;
    S = exp2_clamped(q);

    vec3 orb_next = get_orbit(k);
    float x_next = orb_next.x;
    float y_next = orb_next.y;
    float os_next = orb_next.z;

    // If we haven't computed/uploaded this part of the reference orbit yet, stop cleanly.
    // (Sentinel texels are filled with -1.)
    if (x_next == -1. && y_next == -1.) {
      break;
    }

    float e_orb = exp2_clamped(os_next);
    float fx = x_next * e_orb + S * dx;
    float fy = y_next * e_orb + S * dy;
    if (fx * fx + fy * fy > 4.){
      break;
    }


    if ( true && dx * dx + dy * dy > 1000000.) {
      dx = dx / 2.;
      dy = dy / 2.;
      q = q + 1.0;
      S = exp2_clamped(q);
      dcx = d.x * exp2_clamped(-q + cq);
      dcy = d.y * exp2_clamped(-q + cq);
    }
    if ( false && dx * dx + dy * dy < .25) {
      dx = dx * 2.;
      dy = dy * 2.;
      q = q - 1.0;
      S = exp2_clamped(q);
      dcx = d.x * exp2_clamped(-q + cq);
      dcy = d.y * exp2_clamped(-q + cq);
    }

    if (true  && fx * fx + fy * fy < S * S * dx * dx + S * S * dy * dy) {
      dx  = fx;
      dy = fy;
      q = 0.0;
      S = exp2_clamped(q);
      dcx = d.x * exp2_clamped(-q + cq);
      dcy = d.y * exp2_clamped(-q + cq);
      k = 0;
      orb_next = get_orbit(0);
      x = orb_next.x;
      y = orb_next.y;
      os_prev = orb_next.z;
      continue;
    }

    x = x_next;
    y = y_next;
    os_prev = os_next;
  }
  float c = (uTargetIters - float(j)) / uState[1];
  fragColor = vec4(vec3(cos(c), cos(1.1214 * c) , cos(.8 * c)) / -2. + .5, 1.);
}
  `;
    const shaderProgram = initShaderProgram(gl, vsSource, fsSource);
    const programInfo = {
      program: shaderProgram,
      attribLocations: {
        vertexPosition: gl.getAttribLocation(shaderProgram, "aVertexPosition"),
      },
      uniformLocations: {
        projectionMatrix: gl.getUniformLocation(shaderProgram, "uProjectionMatrix"),
        modelViewMatrix: gl.getUniformLocation(shaderProgram, "uModelViewMatrix"),
        state: gl.getUniformLocation(shaderProgram, "uState"),
        targetIters: gl.getUniformLocation(shaderProgram, "uTargetIters"),
        centerDelta: gl.getUniformLocation(shaderProgram, "uCenterDelta"),
        poly1: gl.getUniformLocation(shaderProgram, "poly1"),
        poly2: gl.getUniformLocation(shaderProgram, "poly2"),
        sequence: gl.getUniformLocation(shaderProgram, "sequence"),
      },
    };
    const buffers = initBuffers(gl);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const ORBIT_TEX_W = 1024;
    // Start small; we will grow this if iterations demand it.
    let orbitTexAllocatedH = 0;
    // Allocate texture storage once; per redraw we update it via texSubImage2D.
    function ensureOrbitTextureHeight(minH) {
      if (orbitTexAllocatedH >= minH) return;
      orbitTexAllocatedH = minH;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        ORBIT_TEX_W,
        orbitTexAllocatedH,
        0,
        gl.RGBA,
        gl.FLOAT,
        null,
      );
    }

    // ---- Low-res interaction rendering (render to small FBO, then blit up) ----
    const interactionFbo = gl.createFramebuffer();
    const interactionColorTex = gl.createTexture();
    let interactionW = 0;
    let interactionH = 0;
    function ensureInteractionTarget(w, h) {
      if (interactionW === w && interactionH === h) return;
      interactionW = w;
      interactionH = h;
      // Bind the FBO color texture on a non-zero unit so we don't clobber texture unit 0
      // (unit 0 is reserved for the orbit/reference texture sampler).
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, interactionColorTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, interactionFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, interactionColorTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    let redrawScheduled = false;
    function requestRedraw() {
      if (redrawScheduled) return;
      redrawScheduled = true;
      requestAnimationFrame(() => {
        redrawScheduled = false;
        drawScene(
          gl,
          programInfo,
          buffers,
          tex,
          ORBIT_TEX_W,
          ensureOrbitTextureHeight,
          ensureInteractionTarget,
          interactionFbo,
        );
      });
    }
    mandelbrot_state.callbacks.unshift(requestRedraw);
    // Check for location in URL
    if (window.location.href.includes(";")) {
      document.getElementById("clickpos").innerText = window.location.href;
      updateFromClickpos();
    }
    mandelbrot_state.modified();
  }
  function initBuffers(gl) {
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const positions = [1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, -1.0];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    return {
      position: positionBuffer,
    };
  }
  function sub(a, b) {
    var [am, ae] = a;
    var [bm, be] = b;
    var ret_e = Math.max(ae, be);
    if (ret_e > ae) {
      am = am * Math.pow(2, ae - ret_e);
    } else {
      bm = bm * Math.pow(2, be - ret_e);
    }
    return [am - bm, ret_e];
  }
  function add(a, b) {
    var [am, ae] = a;
    var [bm, be] = b;
    var ret_e = Math.max(ae, be);
    if (ret_e > ae) {
      am = am * Math.pow(2, ae - ret_e);
    } else {
      bm = bm * Math.pow(2, be - ret_e);
    }
    return [am + bm, ret_e];
  }
  function mul(a, b) {
    var [am, ae] = a;
    var [bm, be] = b;

    var m = am * bm,
      e = ae + be;

    if (m != 0) {
      var logm = Math.round(Math.log2(Math.abs(m)));

      m = m / Math.pow(2, logm);
      e = e + logm;
    }
    return [m, e];
  }
  function maxabs(a, b) {
    var [am, ae] = a;
    var [bm, be] = b;
    var ret_e = Math.max(ae, be);
    if (ret_e > ae) {
      am = am * Math.pow(2, ae - ret_e);
    } else {
      bm = bm * Math.pow(2, be - ret_e);
    }
    return [Math.max(Math.abs(am), Math.abs(bm)), ret_e];
  }
  function gt(a, b) {
    var [am, ae] = a;
    var [bm, be] = b;
    var ret_e = Math.max(ae, be);
    if (ret_e > ae) {
      am = am * Math.pow(2, ae - ret_e);
    } else {
      bm = bm * Math.pow(2, be - ret_e);
    }
    return am > bm;
  }

  const ORBIT_TEX_W = 1024;

  const orb_x = mpfr_make(1200);
  const orb_y = mpfr_make(1200);
  const orb_txx = mpfr_make(1200);
  const orb_txy = mpfr_make(1200);
  const orb_tyy = mpfr_make(1200);

  // ---- Orbit caching / incremental extension ----
  // Cache is keyed by reference center only; radius only affects polynomial trust/scaling.
  const ORBIT_CACHE_MAX = 6;
  const orbitCache = new Map(); // key -> { itersComputed, orbitBuffer, orbitTexHUsed, zXStr, zYStr }
  const orbitCacheOrder = []; // LRU (oldest at 0)

  // Current reference center for the orbit (lets us pan/zoom within a neighborhood without rebuilding orbit)
  const ref_center_x = mpfr_make(2000);
  const ref_center_y = mpfr_make(2000);
  let ref_center_key = null;
  const tmp_center_dx = mpfr_make(2000);
  const tmp_center_dy = mpfr_make(2000);
  const tmp_center_num = mpfr_make(2000);
  const tmp_rebase_shift = mpfr_make(2000);

  function setReferenceCenterToCurrent() {
    binding.mpfr_set(ref_center_x, mandelbrot_state.center[0], 0);
    binding.mpfr_set(ref_center_y, mandelbrot_state.center[1], 0);
    ref_center_key = centerKey();
  }

  function rebaseReferenceCenterToEffectiveCenter(cdx, cdy) {
    // When we've been rendering with a float centerDelta, the *effective* center used by the shader is:
    //   c_eff = c_ref + radius * centerDelta
    // Rebasing to the full-precision mandelbrot_state.center can cause a visible "snap" due to float rounding.
    // This rebases to c_eff instead, and also updates mandelbrot_state.center to keep everything consistent.
    binding.mpfr_mul_d(tmp_rebase_shift, mandelbrot_state.radius, cdx, 0);
    binding.mpfr_add(ref_center_x, ref_center_x, tmp_rebase_shift, 0);
    binding.mpfr_mul_d(tmp_rebase_shift, mandelbrot_state.radius, cdy, 0);
    binding.mpfr_add(ref_center_y, ref_center_y, tmp_rebase_shift, 0);

    binding.mpfr_set(mandelbrot_state.center[0], ref_center_x, 0);
    binding.mpfr_set(mandelbrot_state.center[1], ref_center_y, 0);
    ref_center_key = centerKey();
  }

  function getCenterDeltaNdc() {
    // delta = (center - ref_center) / radius, returned as JS floats for a uniform vec2
    binding.mpfr_sub(tmp_center_num, mandelbrot_state.center[0], ref_center_x, 0);
    binding.mpfr_div(tmp_center_dx, tmp_center_num, mandelbrot_state.radius, 0);
    binding.mpfr_sub(tmp_center_num, mandelbrot_state.center[1], ref_center_y, 0);
    binding.mpfr_div(tmp_center_dy, tmp_center_num, mandelbrot_state.radius, 0);
    const dx = binding.mpfr_get_d(tmp_center_dx, 0);
    const dy = binding.mpfr_get_d(tmp_center_dy, 0);
    return [dx, dy];
  }

  function mpfrKey2(x) {
    // Cheap-ish key: float mantissa + mpfr exponent. This is not collision-proof, but good enough for caching.
    // (Avoid mpfr_to_string here because it can be huge at deep zoom.)
    var _ = 0;
    const m = binding.mpfr_get_d_2exp(_, x, 0);
    const e = binding.mpfr_get_exp(x);
    return m.toPrecision(16) + "@" + e;
  }

  function centerKey() {
    return mpfrKey2(mandelbrot_state.center[0]) + "|" + mpfrKey2(mandelbrot_state.center[1]);
  }

  function touchOrbitKey(key) {
    const idx = orbitCacheOrder.indexOf(key);
    if (idx >= 0) orbitCacheOrder.splice(idx, 1);
    orbitCacheOrder.push(key);
    while (orbitCacheOrder.length > ORBIT_CACHE_MAX) {
      const old = orbitCacheOrder.shift();
      orbitCache.delete(old);
    }
  }

  function ensureOrbitCapacity(orbitState, itersTarget) {
    const hUsed = Math.ceil(itersTarget / ORBIT_TEX_W);
    const texelCount = ORBIT_TEX_W * hUsed;
    const neededLen = texelCount * 4;
    if (!orbitState.orbitBuffer || orbitState.orbitBuffer.length < neededLen) {
      const next = new Float32Array(neededLen);
      next.fill(-1);
      if (orbitState.orbitBuffer) next.set(orbitState.orbitBuffer.subarray(0, Math.min(orbitState.orbitBuffer.length, neededLen)));
      orbitState.orbitBuffer = next;
    }
    orbitState.orbitTexHUsed = hUsed;
  }

  function buildOrExtendOrbit(key, cx, cy, itersTarget) {
    const iters = itersTarget | 0;
    let st = orbitCache.get(key);
    if (!st) {
      st = {
        itersComputed: 0,
        orbitTexHUsed: 0,
        orbitBuffer: null,
        zXStr: "0",
        zYStr: "0",
      };
      orbitCache.set(key, st);
    }
    touchOrbitKey(key);

    if (st.itersComputed >= iters && st.orbitBuffer) {
      return st;
    }

    ensureOrbitCapacity(st, iters);

    // Resume MPFR state: orb_x/orb_y represent z_{itersComputed}
    if (st.itersComputed === 0) {
      binding.mpfr_set_d(orb_x, 0, 0);
      binding.mpfr_set_d(orb_y, 0, 0);
    } else {
      binding.mpfr_set_string(orb_x, st.zXStr, 10, 0);
      binding.mpfr_set_string(orb_y, st.zYStr, 10, 0);
    }

    var _ = 0;
    for (let i = st.itersComputed; i < iters; i++) {
      const x_exponent = binding.mpfr_get_exp(orb_x);
      const y_exponent = binding.mpfr_get_exp(orb_y);
      let scale_exponent = Math.max(x_exponent, y_exponent);
      if (scale_exponent < -10000) scale_exponent = 0;

      const base = 4 * i;
      st.orbitBuffer[base + 0] =
        binding.mpfr_get_d_2exp(_, orb_x, 0) / Math.pow(2, scale_exponent - x_exponent);
      st.orbitBuffer[base + 1] =
        binding.mpfr_get_d_2exp(_, orb_y, 0) / Math.pow(2, scale_exponent - y_exponent);
      st.orbitBuffer[base + 2] = scale_exponent;
      st.orbitBuffer[base + 3] = 0;

      // MPFR orbit update z <- z^2 + c
      binding.mpfr_mul(orb_txx, orb_x, orb_x, 0);
      binding.mpfr_mul(orb_txy, orb_x, orb_y, 0);
      binding.mpfr_mul(orb_tyy, orb_y, orb_y, 0);
      binding.mpfr_sub(orb_x, orb_txx, orb_tyy, 0);
      binding.mpfr_add(orb_x, orb_x, cx, 0);
      binding.mpfr_add(orb_y, orb_txy, orb_txy, 0);
      binding.mpfr_add(orb_y, orb_y, cy, 0);

      // Early escape for the *reference* orbit (keeps MPFR work bounded if it escapes)
      const fx = [st.orbitBuffer[base + 0], st.orbitBuffer[base + 2]];
      const fy = [st.orbitBuffer[base + 1], st.orbitBuffer[base + 2]];
      if (gt(add(mul(fx, fx), mul(fy, fy)), [400, 0])) {
        st.itersComputed = i + 1;
        st.zXStr = binding.mpfr_to_string(orb_x, 10, 0, false);
        st.zYStr = binding.mpfr_to_string(orb_y, 10, 0, false);
        return st;
      }
    }

    st.itersComputed = iters;
    st.zXStr = binding.mpfr_to_string(orb_x, 10, 0, false);
    st.zYStr = binding.mpfr_to_string(orb_y, 10, 0, false);
    return st;
  }

  // Chunked orbit building to avoid long main-thread stalls (keeps interaction responsive).
  // One global builder at a time (MPFR temporaries are shared).
  let orbitBuildTask = null; // { key, targetIters }
  function scheduleOrbitBuild(key, cx, cy, targetIters) {
    const target = targetIters | 0;
    if (target <= 0) return;
    if (orbitBuildTask && orbitBuildTask.key === key && orbitBuildTask.targetIters === target) return;
    orbitBuildTask = { key, targetIters: target };

    function step() {
      // Task may have been replaced.
      if (!orbitBuildTask || orbitBuildTask.key !== key || orbitBuildTask.targetIters !== target) return;

      let st = orbitCache.get(key);
      if (!st) {
        st = {
          itersComputed: 0,
          orbitTexHUsed: 0,
          orbitBuffer: null,
          zXStr: "0",
          zYStr: "0",
        };
        orbitCache.set(key, st);
      }
      touchOrbitKey(key);
      ensureOrbitCapacity(st, target);

      // Resume MPFR state
      if (st.itersComputed === 0) {
        binding.mpfr_set_d(orb_x, 0, 0);
        binding.mpfr_set_d(orb_y, 0, 0);
      } else {
        binding.mpfr_set_string(orb_x, st.zXStr, 10, 0);
        binding.mpfr_set_string(orb_y, st.zYStr, 10, 0);
      }

      // Compute a small chunk per tick
      const CHUNK = 256;
      const end = Math.min(target, st.itersComputed + CHUNK);
      var _ = 0;
      for (let i = st.itersComputed; i < end; i++) {
        const x_exponent = binding.mpfr_get_exp(orb_x);
        const y_exponent = binding.mpfr_get_exp(orb_y);
        let scale_exponent = Math.max(x_exponent, y_exponent);
        if (scale_exponent < -10000) scale_exponent = 0;

        const base = 4 * i;
        st.orbitBuffer[base + 0] =
          binding.mpfr_get_d_2exp(_, orb_x, 0) / Math.pow(2, scale_exponent - x_exponent);
        st.orbitBuffer[base + 1] =
          binding.mpfr_get_d_2exp(_, orb_y, 0) / Math.pow(2, scale_exponent - y_exponent);
        st.orbitBuffer[base + 2] = scale_exponent;
        st.orbitBuffer[base + 3] = 0;

        // z <- z^2 + c (reference center)
        binding.mpfr_mul(orb_txx, orb_x, orb_x, 0);
        binding.mpfr_mul(orb_txy, orb_x, orb_y, 0);
        binding.mpfr_mul(orb_tyy, orb_y, orb_y, 0);
        binding.mpfr_sub(orb_x, orb_txx, orb_tyy, 0);
        binding.mpfr_add(orb_x, orb_x, cx, 0);
        binding.mpfr_add(orb_y, orb_txy, orb_txy, 0);
        binding.mpfr_add(orb_y, orb_y, cy, 0);

        // Early escape of reference orbit
        const fx = [st.orbitBuffer[base + 0], st.orbitBuffer[base + 2]];
        const fy = [st.orbitBuffer[base + 1], st.orbitBuffer[base + 2]];
        if (gt(add(mul(fx, fx), mul(fy, fy)), [400, 0])) {
          st.itersComputed = i + 1;
          st.zXStr = binding.mpfr_to_string(orb_x, 10, 0, false);
          st.zYStr = binding.mpfr_to_string(orb_y, 10, 0, false);
          orbitBuildTask = null;
          mandelbrot_state.modified();
          return;
        }
      }

      st.itersComputed = end;
      st.zXStr = binding.mpfr_to_string(orb_x, 10, 0, false);
      st.zYStr = binding.mpfr_to_string(orb_y, 10, 0, false);

      if (st.itersComputed >= target) {
        orbitBuildTask = null;
        mandelbrot_state.modified();
        return;
      }

      // Yield back to the browser; keep extending soon.
      setTimeout(step, 0);
    }

    setTimeout(step, 0);
  }

  function computePolyFromOrbit(orbitBuffer, iters, radiusExp) {
    let polylim = 0;
    let Bx = [0, 0];
    let By = [0, 0];
    let Cx = [0, 0];
    let Cy = [0, 0];
    let Dx = [0, 0];
    let Dy = [0, 0];
    let poly = [0, 0, 0, 0, 0, 0];
    let not_failed = true;

    for (let i = 0; i < iters; i++) {
      const base = 4 * i;
      const fx0 = orbitBuffer[base + 0];
      const fy0 = orbitBuffer[base + 1];
      const fe = orbitBuffer[base + 2];

      // Sentinel for unused texels (if orbit escaped early or buffer is shorter than requested)
      if (fx0 === -1.0 && fy0 === -1.0) break;

      const fx = [fx0, fe];
      const fy = [fy0, fe];

      const prev_poly = [Bx, By, Cx, Cy, Dx, Dy];
      [Bx, By, Cx, Cy, Dx, Dy] = [
        add(mul([2, 0], sub(mul(fx, Bx), mul(fy, By))), [1, 0]),
        mul([2, 0], add(mul(fx, By), mul(fy, Bx))),
        sub(add(mul([2, 0], sub(mul(fx, Cx), mul(fy, Cy))), mul(Bx, Bx)), mul(By, By)),
        add(mul([2, 0], add(mul(fx, Cy), mul(fy, Cx))), mul(mul([2, 0], Bx), By)),
        mul([2, 0], add(sub(mul(fx, Dx), mul(fy, Dy)), sub(mul(Cx, Bx), mul(Cy, By)))),
        mul([2, 0], add(add(add(mul(fx, Dy), mul(fy, Dx)), mul(Cx, By)), mul(Cy, Bx))),
      ];

      if (i == 0 || gt(maxabs(Cx, Cy), mul([1000, radiusExp], maxabs(Dx, Dy)))) {
        if (not_failed) {
          poly = prev_poly;
          polylim = i;
        }
      } else {
        not_failed = false;
      }
    }
    return [poly, polylim];
  }
  function floaty(d) {
    return Math.pow(2, d[1]) * d[0];
  }

  // Render "preview" while interacting, then refine to full iterations after idle.
  let interactionUntil = 0;
  let refineTimer = null;
  // Hard interaction latch: if a pointer is down (drag/pinch), always treat as interacting.
  // This prevents “random” full-res frames when events are bursty/throttled.
  let interactionHold = false;
  let lastInteracting = null;
  let lastFreezeLogT = 0;
  // Keep interaction behavior deterministic:
  // lock the iteration budget used for the entire interaction gesture so it doesn't "randomly" change.
  let interactionItersLocked = null;
  let interactionKeyLocked = null;
  let lastCenterKey = null; // Track center to detect when it changes
  let lastOrbitIters = 0; // Track orbit iterations to detect if we need to re-upload texture
  function noteInteraction() {
    interactionUntil = performance.now() + 250;
    if (refineTimer) clearTimeout(refineTimer);
    refineTimer = setTimeout(() => {
      // once input settles, redraw with full iteration budget
      interactionUntil = 0;
      interactionItersLocked = null;
      interactionKeyLocked = null;
      mandelbrot_state.modified();
    }, 220);
  }

  function drawScene(
    gl,
    programInfo,
    buffers,
    tex,
    ORBIT_TEX_W,
    ensureOrbitTextureHeight,
    ensureInteractionTarget,
    interactionFbo,
  ) {
    const now = performance.now();
    const targetIters = mandelbrot_state.iterations | 0;
    const isInteracting = interactionHold || now < interactionUntil;
    if (lastInteracting !== isInteracting) {
      lastInteracting = isInteracting;
      idbg(isInteracting ? "mode=INTERACT" : "mode=IDLE", {
        hold: interactionHold,
        untilMs: Math.max(0, interactionUntil - now),
        iters: targetIters,
      });
    }
    
    // Maintain a reference orbit center while we move within a neighborhood.
    // Only "rebase" the reference center when we drift too far, otherwise update via uniform uCenterDelta.
    if (!ref_center_key) setReferenceCenterToCurrent();
    let [cdx, cdy] = getCenterDeltaNdc();
    if (!isFinite(cdx) || !isFinite(cdy)) {
      setReferenceCenterToCurrent();
      cdx = 0;
      cdy = 0;
    }
    const drift = Math.max(Math.abs(cdx), Math.abs(cdy));
    // Tune: 0.35 means we keep the same reference orbit as long as center stays within ~35% of radius.
    // Never rebase the reference orbit while interacting (prevents jarring changes).
    if (!isInteracting && drift > 0.35) {
      // Rebase in a snapless way (match the effective center used by the shader right before rebasing).
      rebaseReferenceCenterToEffectiveCenter(cdx, cdy);
      cdx = 0;
      cdy = 0;
    }

    // Orbit cache/state is keyed by the reference center, not the current view center.
    const key = ref_center_key;
    const cached = orbitCache.get(key);
    const alreadyComputed = cached ? cached.itersComputed : 0;
    
    // Deterministic interaction: choose an iteration budget once per gesture.
    const currentRefKey = key;
    const centerChanged = lastCenterKey !== currentRefKey;
    lastCenterKey = currentRefKey;
    
    let orbitIters = targetIters;
    if (isInteracting) {
      if (interactionKeyLocked !== currentRefKey) {
        interactionKeyLocked = currentRefKey;
        interactionItersLocked = null;
      }
      if (interactionItersLocked == null) {
        // If we don't yet have a full orbit, render immediately with what we have (but lock it for the whole gesture).
        // This avoids "nothing moves then snap" behavior.
        interactionItersLocked = Math.min(targetIters, Math.max(1024, alreadyComputed || 0));
        idbg("lockIters", { locked: interactionItersLocked, target: targetIters, have: alreadyComputed });
      }
      orbitIters = interactionItersLocked;
    } else {
      interactionItersLocked = null;
      interactionKeyLocked = null;
    }

    const needsComputation = alreadyComputed < orbitIters;

    // During interaction, skip orbit computation entirely if we have cached data
    // This makes zoom/pan much more responsive
    let orbitState;
    let orbitTexHUsed;
    const orbitChanged = orbitIters !== lastOrbitIters || centerChanged;
    lastOrbitIters = orbitIters;
    
    if (isInteracting && needsComputation) {
      // Keep drawing using the available prefix of the orbit; extend in the background.
      scheduleOrbitBuild(key, ref_center_x, ref_center_y, orbitIters);
      const t = performance.now();
      if (t - lastFreezeLogT > 250) {
        lastFreezeLogT = t;
        idbg("extend(waiting_orbit)", { have: alreadyComputed, need: orbitIters });
      }
    }

    if (!needsComputation && cached) {
      // Use cached orbit state directly without calling buildOrExtendOrbit
      orbitState = cached;
      orbitTexHUsed = Math.ceil(orbitIters / ORBIT_TEX_W);
    } else {
      // Compute or extend orbit to the full target iteration budget.
      orbitState = buildOrExtendOrbit(key, ref_center_x, ref_center_y, orbitIters);
      orbitTexHUsed = Math.ceil(orbitIters / ORBIT_TEX_W);
    }
    
    // Skip texture upload if orbit data hasn't changed (zooming at same center with same iterations)
    if (orbitChanged) {
      // Calculate how many complete rows we have and if there's a partial row
      const completeRows = Math.floor(orbitIters / ORBIT_TEX_W);
      const partialRowTexels = orbitIters % ORBIT_TEX_W;
      
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      ensureOrbitTextureHeight(orbitTexHUsed);
      
      // Upload complete rows first
      if (completeRows > 0) {
        const completeRowsData = orbitState.orbitBuffer.subarray(0, completeRows * ORBIT_TEX_W * 4);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          ORBIT_TEX_W,
          completeRows,
          gl.RGBA,
          gl.FLOAT,
          completeRowsData,
        );
      }
      
      // Upload partial row if it exists (pad with zeros/sentinels)
      if (partialRowTexels > 0) {
        // Create a buffer for the full row, padding with sentinel values (-1, -1, ...)
        const partialRowBuffer = new Float32Array(ORBIT_TEX_W * 4);
        partialRowBuffer.fill(-1); // Fill with sentinel values
        // Copy the actual data
        const partialDataStart = completeRows * ORBIT_TEX_W * 4;
        const partialData = orbitState.orbitBuffer.subarray(partialDataStart, partialDataStart + partialRowTexels * 4);
        partialRowBuffer.set(partialData, 0);
        
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          completeRows,
          ORBIT_TEX_W,
          1,
          gl.RGBA,
          gl.FLOAT,
          partialRowBuffer,
        );
      }
    }
    
    const radiusExp = binding.mpfr_get_exp(mandelbrot_state.radius);
    
    // Use the orbit buffer for polynomial computation
    const orbit = orbitState.orbitBuffer.subarray(0, orbitIters * 4);
    const [poly, polylim] = computePolyFromOrbit(orbit, orbitIters, radiusExp);
    var minval = 2;
    for (var i = 2; i < orbit.length; i++) {
      minval = Math.min(minval, Math.abs(orbit[i]));
    }
    dbg("smallest orbit bit", minval);
     // Interaction rendering: draw to a smaller framebuffer and blit up to keep motion responsive.
     const canvasW = gl.drawingBufferWidth;
     const canvasH = gl.drawingBufferHeight;
     // More aggressive low-res preview while interacting (keeps iterations/colors identical).
     // Heuristic: deeper iteration budgets get a lower preview resolution.
     const previewScale = targetIters >= 20000 ? 0.25 : 0.33;
     const scale = isInteracting ? previewScale : 1.0;
     const rw = Math.max(2, Math.floor(canvasW * scale));
     const rh = Math.max(2, Math.floor(canvasH * scale));
     ensureInteractionTarget(rw, rh);

     gl.bindFramebuffer(gl.FRAMEBUFFER, interactionFbo);
     gl.viewport(0, 0, rw, rh);
     gl.disable(gl.DEPTH_TEST);
     gl.clearColor(0.0, 0.0, 0.0, 1.0);
     gl.clear(gl.COLOR_BUFFER_BIT);
    let projectionMatrix, modelViewMatrix;
    [projectionMatrix, modelViewMatrix] = createMatrices(gl);
    {
      const numComponents = 2;
      const type = gl.FLOAT;
      const normalize = false;
      const stride = 0;
      const offset = 0;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
      gl.vertexAttribPointer(
        programInfo.attribLocations.vertexPosition,
        numComponents,
        type,
        normalize,
        stride,
        offset,
      );
      gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);
    }
    gl.useProgram(programInfo.program);
    // Make sure texture unit 0 is bound to the orbit/reference texture for sampling.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(programInfo.uniformLocations.sequence, 0);
    gl.uniform2f(programInfo.uniformLocations.centerDelta, cdx, cdy);
    gl.uniformMatrix4fv(programInfo.uniformLocations.projectionMatrix, false, projectionMatrix);
    gl.uniformMatrix4fv(programInfo.uniformLocations.modelViewMatrix, false, modelViewMatrix);
    // Pass a continuous log2(radius) into the shader so zoom is smooth (no exponent snapping).
    binding.mpfr_log2(tmp_log2, mandelbrot_state.radius, 0);
    const log2Radius = binding.mpfr_get_d(tmp_log2, 0);

    // Keep the existing (mantissa, exponent) representation for CPU-side polynomial scaling.
    const rexp = binding.mpfr_get_exp(mandelbrot_state.radius);
    var _ = 0;
    const rMant = binding.mpfr_get_d_2exp(_, mandelbrot_state.radius, 0);
    const r = [rMant, rexp];

    // Keep color normalization stable *within the gesture* by normalizing to orbitIters (locked during interaction).
    gl.uniform1f(programInfo.uniformLocations.targetIters, orbitIters);
    gl.uniform4f(
      programInfo.uniformLocations.state,
      0.0,
      mandelbrot_state.cmapscale,
      log2Radius,
      orbitIters,
    );
    dbg(poly);

    var poly_scale_exp = mul([1, 0], maxabs(poly[0], poly[1]));

    var poly_scale = [1, -poly_scale_exp[1]];

    var poly_scaled = [
      mul(poly_scale, poly[0]),
      mul(poly_scale, poly[1]),
      mul(poly_scale, mul(r, poly[2])),
      mul(poly_scale, mul(r, poly[3])),
      mul(poly_scale, mul(r, mul(r, poly[4]))),
      mul(poly_scale, mul(r, mul(r, poly[5]))),
    ].map(floaty);

    gl.uniform4f(
      programInfo.uniformLocations.poly1,
      poly_scaled[0],
      poly_scaled[1],
      poly_scaled[2],
      poly_scaled[3],
    );
    gl.uniform4f(
      programInfo.uniformLocations.poly2,
      poly_scaled[4],
      poly_scaled[5],
      polylim,
      poly_scale_exp[1],
    );
    dbg("poly_scaled", poly_scaled, polylim, 0);
    {
      const offset = 0;
      const vertexCount = 4;
      gl.drawArrays(gl.TRIANGLE_STRIP, offset, vertexCount);
    }

    // Blit to the default framebuffer (upscale preview if interacting)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, interactionFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    // If the default framebuffer is multisampled, WebGL requires NEAREST for blits.
    const blitFilter = gl.getParameter(gl.SAMPLES) > 0 ? gl.NEAREST : gl.LINEAR;
    gl.blitFramebuffer(0, 0, rw, rh, 0, 0, canvasW, canvasH, gl.COLOR_BUFFER_BIT, blitFilter);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
    // No iteration-preview mode: orbit is always built to targetIters (or we freeze while interacting).
  }
});
