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
    float sideBlue = clamp(exp(-pow(leftCurve * 3.2, 2.0)) + exp(-pow(rightCurve * 3.6, 2.0)), 0.0, 0.9);
    vec3 black = vec3(0.047, 0.047, 0.055);
    vec3 color = mix(black, vec3(0.192, 0.204, 0.200), smoothstep(0.46, 0.82, detail) * 0.28);
    color = mix(color, vec3(0.051, 0.071, 0.129), sideBlue);
    color = mix(color, vec3(0.129, 0.235, 0.208), centerGreen * 0.78);
    color = mix(color, vec3(0.204, 0.329, 0.282), jadeEdge * 0.82);
    color = mix(color, vec3(0.247, 0.196, 0.094), goldBand * 0.48);
    color = mix(color, vec3(0.373, 0.341, 0.220), goldBand * 0.55);
    color = mix(color, vec3(0.396, 0.333, 0.137), goldCore * 0.72);
    float vignette = smoothstep(1.18, 0.24, length((uv - 0.5) * vec2(1.05, 0.82)));
    return mix(black, color, 0.42 + vignette * 0.58);
  }

  float roundedBoxSdf(vec2 position, vec2 halfSize, float radius) {
    vec2 q = abs(position) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }

  float smoothUnion(float first, float second, float radius) {
    float blend = clamp(0.5 + 0.5 * (second - first) / radius, 0.0, 1.0);
    return mix(second, first, blend) - radius * blend * (1.0 - blend);
  }

  float capsuleSdf(vec2 position, vec2 start, vec2 end, float radius) {
    vec2 segment = end - start;
    float amount = clamp(dot(position - start, segment) / max(dot(segment, segment), 0.0001), 0.0, 1.0);
    return length(position - start - segment * amount) - radius;
  }

  vec2 blobCenter(float index) {
    if (index < 0.5) return u_resolution * vec2(0.24, 0.21);
    if (index < 1.5) return u_resolution * vec2(0.50, 0.52);
    return u_resolution * vec2(0.76, 0.83);
  }

  vec2 blobHalfSize(float index) {
    if (index < 0.5) return u_resolution * vec2(0.20, 0.145);
    if (index < 1.5) return u_resolution * vec2(0.25, 0.19);
    return u_resolution * vec2(0.20, 0.145);
  }

  float liquidGlassSdf(vec2 pixel) {
    vec2 viewportCenter = u_resolution * 0.5;
    float home = roundedBoxSdf(pixel - viewportCenter, viewportCenter - vec2(u_inset), u_radius);
    float minimumSide = min(u_resolution.x, u_resolution.y);
    vec2 center0 = blobCenter(0.0);
    vec2 center1 = blobCenter(1.0);
    vec2 center2 = blobCenter(2.0);
    vec2 half0 = blobHalfSize(0.0);
    vec2 half1 = blobHalfSize(1.0);
    vec2 half2 = blobHalfSize(2.0);
    float cornerRadius = minimumSide * 0.055;
    float about = smoothUnion(
      roundedBoxSdf(pixel - center0, half0, cornerRadius),
      roundedBoxSdf(pixel - center1, half1, cornerRadius * 1.12),
      minimumSide * 0.018
    );
    about = smoothUnion(about, roundedBoxSdf(pixel - center2, half2, cornerRadius), minimumSide * 0.018);
    float neckRadius = minimumSide * 0.056;
    float neck01X = mix(center0.x + half0.x, center1.x - half1.x, 0.5);
    float neck12X = mix(center1.x + half1.x, center2.x - half2.x, 0.5);
    about = smoothUnion(
      about,
      capsuleSdf(pixel, vec2(neck01X, center0.y + half0.y), vec2(neck01X, center1.y - half1.y), neckRadius),
      minimumSide * 0.024
    );
    about = smoothUnion(
      about,
      capsuleSdf(pixel, vec2(neck12X, center1.y + half1.y), vec2(neck12X, center2.y - half2.y), neckRadius),
      minimumSide * 0.024
    );
    return mix(home, about, u_transition);
  }

  vec2 rippleDisplacement(vec2 uv, out float waveLight) {
    float aspect = u_resolution.x / u_resolution.y;
    vec2 displacement = vec2(0.0);
    waveLight = 0.0;
    for (int index = 0; index < 6; index++) {
      vec4 ripple = u_ripples[index];
      float age = u_time - ripple.z;
      if (age > 0.0 && age < 4.2 && ripple.w > 0.0) {
        vec2 delta = uv - ripple.xy;
        delta.x *= aspect;
        float distanceToCenter = length(delta);
        float distanceFromFront = distanceToCenter - age * 0.235;
        float arrival = 1.0 - smoothstep(0.018, 0.072, distanceFromFront);
        float envelope = arrival * exp(-max(age * 0.235 - distanceToCenter, 0.0) * 4.8);
        float waveSlope = cos(distanceFromFront * 135.0 - 0.35) * envelope * exp(-age * 0.48) * ripple.w;
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
    vec2 localPosition = pixel - center;
    vec2 halfSize = center - vec2(u_inset);
    float sdf = liquidGlassSdf(pixel);
    float glassMask = 1.0 - smoothstep(-26.0, 10.0, sdf);
    vec2 edgeNormal = normalize(vec2(
      liquidGlassSdf(pixel + vec2(1.5, 0.0)) - liquidGlassSdf(pixel - vec2(1.5, 0.0)),
      liquidGlassSdf(pixel + vec2(0.0, 1.5)) - liquidGlassSdf(pixel - vec2(0.0, 1.5))
    ) + vec2(0.0001));
    vec2 panelCoordinate = localPosition / max(halfSize, vec2(1.0));
    float curvature = clamp(dot(panelCoordinate, panelCoordinate), 0.0, 1.0);
    float waveLight;
    vec2 waveOffset = rippleDisplacement(uv, waveLight) * u_motion;
    float surfacePhase = u_time * 0.022;
    float surface = sin(uv.x * 13.0 + surfacePhase) * sin(uv.y * 9.0 - surfacePhase * 0.7) * 0.5 + 0.5;
    vec2 glassNormal = vec2(cos(uv.x * 13.0 + surfacePhase), -cos(uv.y * 9.0 - surfacePhase * 0.7)) * 0.0022;
    float pointerDistance = distance((uv - u_pointer) * vec2(u_resolution.x / u_resolution.y, 1.0), vec2(0.0));
    float pointerLens = pointerDistance * exp(-pointerDistance * pointerDistance * 44.0) * u_motion;
    vec2 pointerDirection = normalize(uv - u_pointer + vec2(0.0001));
    vec2 refraction = waveOffset + glassNormal + pointerDirection * pointerLens * 0.070;
    refraction += panelCoordinate * curvature * glassMask * 0.0038;
    refraction += edgeNormal * exp(-max(-sdf, 0.0) * 0.045) * glassMask * 0.010;

    vec2 viewCenter = uv - 0.5;
    vec2 mouseTilt = (u_pointer - 0.5) * 2.0 * u_motion;
    vec2 sceneUv = uv + refraction * glassMask;
    vec3 scene = flowingBackground(sceneUv, u_time * u_motion, u_transition);
    vec2 logoUv = viewCenter / clamp(1.0 + dot(viewCenter, mouseTilt) * 0.24, 0.76, 1.24) + 0.5;
    logoUv += refraction * glassMask - mouseTilt * 0.009;
    vec4 logoLayer = texture2D(u_logoTexture, logoUv);
    scene = mix(scene, logoLayer.rgb, logoLayer.a * 0.90 * (1.0 - u_transition));

    float innerEdge = exp(-abs(sdf) * 0.055) * glassMask;
    float pointerGlow = exp(-pointerDistance * pointerDistance * 27.0) * 0.16 * u_motion;
    vec3 glass = scene * vec3(0.98, 1.0, 1.025);
    glass = mix(glass, vec3(0.192, 0.204, 0.200), mix(0.12, 0.19, u_transition));
    glass += vec3(0.204, 0.329, 0.282) * surface * 0.026;
    glass += vec3(1.0) * (innerEdge * mix(0.020, 0.052, u_transition) + pointerGlow);
    glass += vec3(0.82, 0.95, 1.0) * max(waveLight, 0.0) * 0.042;
    glass -= vec3(0.12, 0.20, 0.32) * max(-waveLight, 0.0) * 0.055;
    float outerShadow = smoothstep(46.0, 1.0, sdf) * step(0.0, sdf);
    vec3 color = mix(scene * (1.0 - outerShadow * mix(0.030, 0.085, u_transition)), glass, glassMask);
    color = pow(1.0 - exp(-color * 1.22), vec3(0.94));

    vec2 textUv = viewCenter / clamp(1.0 - dot(viewCenter, mouseTilt) * 0.07, 0.95, 1.05) + 0.5;
    textUv += refraction * glassMask * 0.9 + mouseTilt * 0.002;
    vec4 heroText = texture2D(u_textTexture, textUv);
    color = mix(color, heroText.rgb, heroText.a * 0.96);
    gl_FragColor = vec4(color, 1.0);
  }
`;
