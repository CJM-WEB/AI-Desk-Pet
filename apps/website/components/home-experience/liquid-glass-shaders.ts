export const LIQUID_GLASS_VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

export const LIQUID_GLASS_FRAGMENT_SHADER = `
  precision mediump float;

  varying vec2 v_uv;
  uniform vec2 u_resolution;
  uniform vec2 u_pointer;
  uniform float u_time;
  uniform float u_inset;
  uniform float u_radius;
  uniform float u_motion;
  uniform float u_transition;
  uniform vec4 u_ripples[6];
  uniform sampler2D u_logoTexture;
  uniform sampler2D u_textTexture;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + 1.0), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.55;
    mat2 rotation = mat2(0.8, -0.6, 0.6, 0.8);

    for (int i = 0; i < 3; i++) {
      value += amplitude * noise(p);
      p = rotation * p * 2.03 + 7.1;
      amplitude *= 0.5;
    }

    return value;
  }

  vec3 flowingBackground(vec2 uv, float time, float transition) {
    float aspect = u_resolution.x / u_resolution.y;
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    p += vec2(
      sin(transition * 2.7 + p.y * 1.8) * transition * 0.72,
      cos(transition * 2.1 + p.x * 1.4) * transition * 0.46
    );
    float t = time * 0.24;

    vec2 warp = vec2(
      sin(p.y * 1.37 + t * 0.82) * 0.18 + sin(p.y * 2.73 - t * 0.51) * 0.075,
      sin(p.x * 1.18 - t * 0.46) * 0.14 + sin((p.x + p.y) * 2.14 + t * 0.34) * 0.055
    );
    float detail = sin(p.x * 2.3 - p.y * 1.64 + t * 0.57) * 0.5 + 0.5;

    float centerCurve = p.x - 0.27 * sin(p.y * 1.72 + t * 0.72) - warp.x;
    float leftCurve = p.x + 0.78 + 0.22 * sin(p.y * 2.08 - t * 0.48) + warp.y;
    float rightCurve = p.x - 0.88 - 0.25 * sin(p.y * 1.86 + t * 0.41) - warp.y * 0.72;

    float centerGreen = exp(-pow(centerCurve * 2.45, 2.0));
    float jadeEdge = exp(-pow((centerCurve + 0.22) * 7.5, 2.0));
    float goldBand = exp(-pow((centerCurve - 0.17) * 6.4, 2.0));
    float goldCore = exp(-pow((centerCurve - 0.22) * 12.0, 2.0));
    float leftBlue = exp(-pow(leftCurve * 3.2, 2.0));
    float rightBlue = exp(-pow(rightCurve * 3.6, 2.0));

    vec3 black = vec3(0.047, 0.047, 0.055);
    vec3 graphite = vec3(0.192, 0.204, 0.200);
    vec3 ash = vec3(0.333, 0.333, 0.322);
    vec3 forest = vec3(0.129, 0.235, 0.208);
    vec3 navy = vec3(0.051, 0.071, 0.129);
    vec3 jade = vec3(0.204, 0.329, 0.282);
    vec3 umber = vec3(0.247, 0.196, 0.094);
    vec3 olive = vec3(0.373, 0.341, 0.220);
    vec3 gold = vec3(0.396, 0.333, 0.137);

    vec3 color = mix(black, graphite, smoothstep(0.46, 0.82, detail) * 0.28);
    color = mix(color, navy, clamp(leftBlue + rightBlue, 0.0, 0.9));
    color = mix(color, forest, centerGreen * 0.78);
    color = mix(color, jade, jadeEdge * 0.82);
    color = mix(color, umber, goldBand * 0.48);
    color = mix(color, olive, goldBand * 0.55);
    color = mix(color, gold, goldCore * 0.72);
    color = mix(color, ash, goldCore * smoothstep(0.58, 0.86, detail) * 0.16);

    float vignette = smoothstep(1.18, 0.24, length((uv - 0.5) * vec2(1.05, 0.82)));
    return mix(black, color, 0.42 + vignette * 0.58);
  }

  float roundedBoxSdf(vec2 position, vec2 halfSize, float radius) {
    vec2 q = abs(position) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }

  vec2 rippleDisplacement(vec2 uv, out float waveLight) {
    float aspect = u_resolution.x / u_resolution.y;
    vec2 displacement = vec2(0.0);
    waveLight = 0.0;

    for (int i = 0; i < 6; i++) {
      vec4 ripple = u_ripples[i];
      float age = u_time - ripple.z;

      if (age > 0.0 && age < 4.2 && ripple.w > 0.0) {
        vec2 delta = uv - ripple.xy;
        delta.x *= aspect;
        float distanceToCenter = length(delta);
        float edgeVariation = sin(delta.x * 41.0 + delta.y * 29.0 + age * 1.8) * 0.0045;
        distanceToCenter += edgeVariation;
        float front = age * 0.235;
        float distanceFromFront = distanceToCenter - front;
        float arrival = 1.0 - smoothstep(0.018, 0.072, distanceFromFront);
        float trailDistance = max(front - distanceToCenter, 0.0);
        float envelope = arrival * exp(-trailDistance * 4.8);
        float decay = exp(-age * 0.48) * ripple.w;
        float primarySlope = cos(distanceFromFront * 135.0 - 0.35);
        float secondarySlope = cos(distanceFromFront * 78.0 + age * 0.45) * 0.28;
        float leadingCrest = exp(-pow(distanceFromFront * 46.0, 2.0)) * 0.24;
        float waveSlope = (primarySlope + secondarySlope) * envelope * decay + leadingCrest * decay;
        vec2 direction = delta / max(distanceToCenter, 0.002);
        direction.x /= aspect;

        displacement += direction * waveSlope * 0.018;
        waveLight += waveSlope;
      }
    }

    return displacement;
  }

  void main() {
    vec2 uv = v_uv;
    vec2 pixel = uv * u_resolution;
    vec2 center = u_resolution * 0.5;
    vec2 halfSize = center - vec2(u_inset);
    vec2 localPosition = pixel - center;
    float sdf = roundedBoxSdf(localPosition, halfSize, u_radius);
    float glassMask = (1.0 - smoothstep(-26.0, 10.0, sdf))
      * (1.0 - smoothstep(0.16, 0.88, u_transition));

    vec2 edgeQuery = abs(localPosition) - halfSize + u_radius;
    vec2 cornerVector = max(edgeQuery, 0.0);
    vec2 sideNormal = edgeQuery.x > edgeQuery.y
      ? vec2(sign(localPosition.x), 0.0)
      : vec2(0.0, sign(localPosition.y));
    vec2 cornerNormal = normalize(cornerVector + vec2(0.0001)) * sign(localPosition);
    vec2 edgeNormal = mix(sideNormal, cornerNormal, step(0.0001, dot(cornerVector, cornerVector)));
    float edgeLens = exp(-max(-sdf, 0.0) * 0.045) * glassMask;
    vec2 panelCoordinate = localPosition / max(halfSize, vec2(1.0));
    float curvature = clamp(dot(panelCoordinate, panelCoordinate), 0.0, 1.0);

    float waveLight;
    vec2 waveOffset = rippleDisplacement(uv, waveLight) * u_motion;

    float surfacePhase = u_time * 0.022;
    float surface = sin(uv.x * 13.0 + surfacePhase) * sin(uv.y * 9.0 - surfacePhase * 0.7) * 0.5 + 0.5;
    vec2 glassNormal = vec2(
      cos(uv.x * 13.0 + surfacePhase) * 0.65 + cos((uv.x + uv.y) * 8.0 - surfacePhase * 1.3) * 0.35,
      -cos(uv.y * 9.0 - surfacePhase * 0.7) * 0.65 + sin((uv.x - uv.y) * 10.0 + surfacePhase) * 0.35
    ) * 0.0022;

    float pointerDistance = distance((uv - u_pointer) * vec2(u_resolution.x / u_resolution.y, 1.0), vec2(0.0));
    float pointerLens = pointerDistance * exp(-pointerDistance * pointerDistance * 44.0) * u_motion;
    vec2 pointerDirection = normalize(uv - u_pointer + vec2(0.0001));
    vec2 refraction = waveOffset + glassNormal + pointerDirection * pointerLens * 0.070;
    refraction += panelCoordinate * curvature * glassMask * 0.0038;
    refraction += edgeNormal * edgeLens * 0.010;

    vec2 viewCenter = uv - 0.5;
    vec2 mouseTilt = (u_pointer - 0.5) * 2.0 * u_motion;
    vec2 sceneUv = uv + refraction * glassMask;
    vec3 background = flowingBackground(sceneUv, u_time * u_motion, u_transition);
    float logoPerspective = clamp(1.0 + dot(viewCenter, mouseTilt) * 0.24, 0.76, 1.24);
    vec2 logoUv = viewCenter / logoPerspective + 0.5;
    logoUv += refraction * glassMask - mouseTilt * 0.009;
    vec2 logoBlurRadius = vec2(6.0) / u_resolution;
    vec4 logoSharp = texture2D(u_logoTexture, logoUv);
    vec4 logoSoft = logoSharp * 0.40;
    logoSoft += texture2D(u_logoTexture, logoUv + logoBlurRadius) * 0.15;
    logoSoft += texture2D(u_logoTexture, logoUv - logoBlurRadius) * 0.15;
    logoSoft += texture2D(u_logoTexture, logoUv + vec2(logoBlurRadius.x, -logoBlurRadius.y)) * 0.15;
    logoSoft += texture2D(u_logoTexture, logoUv + vec2(-logoBlurRadius.x, logoBlurRadius.y)) * 0.15;
    vec4 logoLayer = mix(logoSharp, logoSoft, glassMask * 0.94);
    vec3 scene = mix(background, logoLayer.rgb, logoLayer.a * 0.90 * (1.0 - u_transition));

    float innerEdge = exp(-abs(sdf) * 0.055) * glassMask;
    float razorEdge = exp(-abs(sdf) * 0.7);
    float topLight = smoothstep(-0.15, 0.72, dot(normalize(pixel - center + vec2(0.001)), normalize(vec2(-0.72, 0.7))));
    float pointerGlow = exp(-pointerDistance * pointerDistance * 27.0) * 0.16 * u_motion;
    float caustic = clamp(abs(waveLight) * 0.05, 0.0, 0.045);
    float refractiveShade = dot(edgeNormal, normalize(vec2(-0.66, 0.75))) * edgeLens;

    vec3 glass = scene * vec3(0.98, 1.0, 1.025);
    glass = mix(glass, vec3(0.192, 0.204, 0.200), 0.12);
    glass += vec3(0.204, 0.329, 0.282) * surface * 0.026;
    glass += vec3(1.0, 1.0, 1.0) * (innerEdge * 0.020 + pointerGlow + caustic);
    glass += vec3(0.38, 0.62, 1.0) * innerEdge * (1.0 - topLight) * 0.024;
    glass += vec3(1.0, 0.99, 0.96) * razorEdge * topLight * 0.075;
    glass += vec3(0.76, 0.94, 1.0) * max(refractiveShade, 0.0) * 0.018;
    glass -= vec3(0.10, 0.16, 0.20) * max(-refractiveShade, 0.0) * 0.014;
    glass += vec3(0.82, 0.95, 1.0) * max(waveLight, 0.0) * 0.042;
    glass -= vec3(0.12, 0.20, 0.32) * max(-waveLight, 0.0) * 0.055;

    float outerShadow = smoothstep(46.0, 1.0, sdf) * step(0.0, sdf);
    vec3 color = scene * (1.0 - outerShadow * 0.030);
    color = mix(color, glass, glassMask);

    color = 1.0 - exp(-color * 1.22);
    color = pow(color, vec3(0.94));

    float textPerspective = clamp(1.0 - dot(viewCenter, mouseTilt) * 0.10, 0.90, 1.10);
    vec2 textUv = viewCenter / textPerspective + 0.5;
    textUv += refraction * glassMask * 0.9 + mouseTilt * 0.0035;
    vec4 heroText = texture2D(u_textTexture, textUv);
    color = mix(color, heroText.rgb, heroText.a * 0.96);

    gl_FragColor = vec4(color, 1.0);
  }
`;
