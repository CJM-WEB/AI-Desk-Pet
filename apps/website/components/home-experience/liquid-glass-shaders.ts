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
  uniform float u_downloadTransition;
  uniform float u_communityTransition;
  uniform float u_supportTransition;
  uniform float u_supportFeedbackActive;
  uniform float u_supportPaymentActive;
  uniform float u_communityCardCount;
  uniform vec2 u_blobOffsets[3];
  uniform float u_hoveredBlob;
  uniform float u_hoverAmount;
  uniform float u_dragging;
  uniform float u_rippleActivity;
  uniform vec4 u_ripples[6];
  uniform sampler2D u_logoTexture;
  uniform sampler2D u_textTexture;
  uniform sampler2D u_cornerTextTexture;
  uniform sampler2D u_glassTextTexture;
  uniform sampler2D u_downloadTextTexture;
  uniform sampler2D u_communityTextTexture;
  uniform sampler2D u_supportTextTexture;

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

  vec3 flowingBackground(
    vec2 uv,
    float time,
    float transition,
    float downloadTransition,
    float communityTransition,
    float supportTransition
  ) {
    float aspect = u_resolution.x / u_resolution.y;
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    p += vec2(
      sin(transition * 2.7 + p.y * 1.8) * transition * 0.72,
      cos(transition * 2.1 + p.x * 1.4) * transition * 0.46
    );
    /* 下载过渡只平移既有色带，不改变颜色与轮廓形状。 */
    p += vec2(
      sin(downloadTransition * 2.7) * downloadTransition * 1.18,
      cos(downloadTransition * 2.2) * downloadTransition * 0.86
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

    /* 第四模块只重排既有色带，将纵向流体过渡为缓慢横向波浪。 */
    vec2 communityP = (uv - 0.5) * vec2(aspect, 1.0);
    float waveCenter = sin(communityP.x * 3.0 - t * 0.18) * 0.17
      + sin(communityP.x * 5.8 + t * 0.12) * 0.026;
    float supportWaveCenter = sin((communityP.x + 0.58) * 3.0 - t * 0.18) * 0.17
      + sin((communityP.x - 0.34) * 5.8 + t * 0.12) * 0.026
      + 0.12;
    waveCenter = mix(waveCenter, supportWaveCenter, supportTransition);
    float horizontalWave = communityP.y - waveCenter;
    float waveJade = exp(-pow(horizontalWave * 5.2, 2.0));
    float waveGold = exp(-pow((horizontalWave - 0.10) * 7.2, 2.0));
    float waveBlue = exp(-pow((horizontalWave + 0.14) * 6.6, 2.0));
    vec3 communityColor = mix(black, graphite, smoothstep(0.42, 0.82, detail) * 0.24);
    communityColor = mix(communityColor, navy, waveBlue * 0.94);
    communityColor = mix(communityColor, forest, waveJade * 0.78);
    communityColor = mix(communityColor, jade, waveJade * 0.42);
    communityColor = mix(communityColor, olive, waveGold * 0.72);
    communityColor = mix(communityColor, gold, waveGold * 0.62);
    color = mix(color, communityColor, communityTransition);

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

  float selectedBlob(float index) {
    return 1.0 - step(0.49, abs(u_hoveredBlob - index));
  }

  float disconnectionAmount() {
    return max(u_hoverAmount, max(u_dragging, u_rippleActivity));
  }

  vec2 blobCenter(float index) {
    float minimumSide = min(u_resolution.x, u_resolution.y);
    float separation = minimumSide * 0.075 * disconnectionAmount();
    if (index < 0.5) {
      return u_resolution * vec2(0.24, 0.21) + u_blobOffsets[0] * u_resolution
        + vec2(-separation * 0.65, -separation)
        + vec2(0.0, sin(u_time * 0.55) * minimumSide * 0.020 * u_motion);
    }
    if (index < 1.5) {
      return u_resolution * vec2(0.50, 0.52) + u_blobOffsets[1] * u_resolution
        + vec2(0.0, sin(u_time * 0.47 + 2.1) * minimumSide * 0.026 * u_motion);
    }
    return u_resolution * vec2(0.76, 0.83) + u_blobOffsets[2] * u_resolution
      + vec2(separation * 0.65, separation)
      + vec2(0.0, sin(u_time * 0.51 + 4.0) * minimumSide * 0.020 * u_motion);
  }

  vec2 blobHalfSize(float index) {
    if (index < 0.5) {
      return u_resolution * vec2(0.20, 0.145) * (1.0 + selectedBlob(0.0) * u_hoverAmount * 0.22);
    }
    if (index < 1.5) {
      return u_resolution * vec2(0.25, 0.19) * (1.0 + selectedBlob(1.0) * u_hoverAmount * 0.22);
    }
    return u_resolution * vec2(0.20, 0.145) * (1.0 + selectedBlob(2.0) * u_hoverAmount * 0.22);
  }

  vec2 downloadGlassCenter() {
    float floating = sin(u_time * 0.62 + 0.8) * min(u_resolution.x, u_resolution.y) * 0.012;
    return u_resolution * vec2(0.265, 0.50)
      + vec2(0.0, floating * u_motion * u_downloadTransition);
  }

  vec2 communityGlassCenter() {
    float floating = sin(u_time * 0.54 + 1.1) * min(u_resolution.x, u_resolution.y) * 0.018;
    return u_resolution * vec2(0.50, 0.50)
      + vec2(0.0, floating * u_motion * u_communityTransition);
  }

  vec2 rotatePoint(vec2 point, float angle) {
    float sine = sin(angle);
    float cosine = cos(angle);
    return mat2(cosine, -sine, sine, cosine) * point;
  }

  /* 资源卡片与 DOM 网格共享位置、错峰入场和轻微浮动。 */
  float communityCardsSdf(vec2 pixel) {
    float result = 100000.0;
    float minimumSide = min(u_resolution.x, u_resolution.y);

    for (int index = 0; index < 8; index++) {
      float order = float(index);
      if (order >= u_communityCardCount) continue;
      float row = floor(order / 4.0);
      float column = mod(order, 4.0);
      float entry = clamp(
        (u_communityTransition - 0.10 - order * 0.045) / 0.54,
        0.0,
        1.0
      );
      vec2 center = u_resolution * vec2(0.14 + column * 0.24, mix(0.19, 0.81, row));
      center.x += (1.0 - entry) * u_resolution.x * 1.18;
      center.x -= u_supportTransition * u_resolution.x * 1.22;
      center.y += sin(u_time * 0.61 + order * 1.37) * minimumSide * 0.008 * u_motion * entry;

      float angle = 0.0;
      if (index == 0 || index == 5) angle = -0.056;
      if (index == 1 || index == 6) angle = 0.030;
      if (index == 2 || index == 7) angle = -0.024;
      if (index == 3 || index == 4) angle = 0.049;
      vec2 local = rotatePoint(pixel - center, -angle);
      float card = roundedBoxSdf(
        local,
        u_resolution * vec2(0.105, 0.145),
        minimumSide * 0.038
      );
      result = min(result, card);
    }
    return result;
  }

  float supportButtonPhase(float index) {
    float stackIndex = mod(index, 3.0);
    float onLeft = 1.0 - step(2.5, index);
    float activeIndex = mix(u_supportPaymentActive, u_supportFeedbackActive, onLeft);
    return (stackIndex - activeIndex) * 2.0943951;
  }

  /* 相位连续映射为前、中、后三层，稳定位置对应 0、1、2。 */
  float supportButtonDepthRank(float index) {
    float phase = supportButtonPhase(index);
    float frontAmount = clamp((cos(phase) + 0.5) / 1.5, 0.0, 1.0);
    float backOrder = smoothstep(-0.05, 0.05, sin(phase));
    return (1.0 - frontAmount) * mix(1.0, 2.0, backOrder);
  }

  float supportButtonBlurPx(float index) {
    float depth = supportButtonDepthRank(index);
    return clamp(depth, 0.0, 2.0) * 2.5;
  }

  float supportButtonScale(float index) {
    float frontAmount = clamp((cos(supportButtonPhase(index)) + 0.5) / 1.5, 0.0, 1.0);
    return mix(0.84, 1.0, frontAmount);
  }

  vec2 supportButtonCenter(float index) {
    float onLeft = 1.0 - step(2.5, index);
    vec2 target = mix(vec2(0.77, 0.74), vec2(0.23, 0.28), onLeft);
    target.y += sin(supportButtonPhase(index)) * 0.092;
    target *= u_resolution;
    float stagger = clamp((u_supportTransition - index * 0.028) / 0.82, 0.0, 1.0);
    float eased = 1.0 - pow(1.0 - stagger, 3.0);
    vec2 center = mix(communityGlassCenter(), target, eased);
    center.y += sin(u_time * 0.68 + index * 1.23)
      * min(u_resolution.x, u_resolution.y) * 0.014 * u_motion * eased;
    return center;
  }

  /* 仅扩宽最近按钮的玻璃边缘，前层与按钮之外保持清晰。 */
  float supportButtonEdgeBlur(vec2 pixel) {
    float nearestSdf = 100000.0;
    float nearestBlur = 0.0;
    float radius = min(u_resolution.x, u_resolution.y) * 0.060;
    for (int index = 0; index < 6; index++) {
      float supportIndex = float(index);
      float scale = supportButtonScale(supportIndex);
      float candidate = roundedBoxSdf(
        pixel - supportButtonCenter(supportIndex),
        u_resolution * vec2(0.145, 0.085) * scale,
        radius * scale
      );
      if (candidate < nearestSdf) {
        nearestSdf = candidate;
        nearestBlur = supportButtonBlurPx(supportIndex);
      }
    }
    return nearestSdf < 24.0 ? nearestBlur : 0.0;
  }

  /* 后层文字固定五点采样；前层直接返回单次清晰采样。 */
  vec4 sampleSupportText(vec2 uv, float blurPx) {
    vec4 sharp = texture2D(u_supportTextTexture, uv);
    if (blurPx <= 0.001) return sharp;
    vec2 supportBlurStep = vec2(blurPx) / u_resolution;
    vec4 softened = sharp * 0.40;
    softened += texture2D(u_supportTextTexture, uv + vec2(supportBlurStep.x, 0.0)) * 0.15;
    softened += texture2D(u_supportTextTexture, uv - vec2(supportBlurStep.x, 0.0)) * 0.15;
    softened += texture2D(u_supportTextTexture, uv + vec2(0.0, supportBlurStep.y)) * 0.15;
    softened += texture2D(u_supportTextTexture, uv - vec2(0.0, supportBlurStep.y)) * 0.15;
    return softened;
  }

  /* 中央玻璃连续裂变为左右两组三层按钮，保持与前四模块一致的材质。 */
  float supportButtonsSdf(vec2 pixel) {
    float result = 100000.0;
    float radius = min(u_resolution.x, u_resolution.y) * 0.060;
    for (int index = 0; index < 6; index++) {
      float scale = supportButtonScale(float(index));
      result = min(
        result,
        roundedBoxSdf(
          pixel - supportButtonCenter(float(index)),
          u_resolution * vec2(0.145, 0.085) * scale,
          radius * scale
        )
      );
    }
    return result;
  }

  float liquidGlassSdf(vec2 pixel) {
    vec2 viewportCenter = u_resolution * 0.5;
    vec2 homeHalfSize = viewportCenter - vec2(u_inset);
    float home = roundedBoxSdf(pixel - viewportCenter, homeHalfSize, u_radius);

    float minimumSide = min(u_resolution.x, u_resolution.y);
    vec2 center0 = blobCenter(0.0);
    vec2 center1 = blobCenter(1.0);
    vec2 center2 = blobCenter(2.0);
    vec2 half0 = blobHalfSize(0.0);
    vec2 half1 = blobHalfSize(1.0);
    vec2 half2 = blobHalfSize(2.0);
    float cornerRadius = minimumSide * 0.055;
    float blob0 = roundedBoxSdf(pixel - center0, half0, cornerRadius);
    float blob1 = roundedBoxSdf(pixel - center1, half1, cornerRadius * 1.12);
    float blob2 = roundedBoxSdf(pixel - center2, half2, cornerRadius);

    float neckRadius = minimumSide * 0.056;
    float neck01X = mix(center0.x + half0.x, center1.x - half1.x, 0.5);
    float neck12X = mix(center1.x + half1.x, center2.x - half2.x, 0.5);
    float neck01 = capsuleSdf(
      pixel,
      vec2(neck01X, center0.y + half0.y),
      vec2(neck01X, center1.y - half1.y),
      neckRadius
    );
    float neck12 = capsuleSdf(
      pixel,
      vec2(neck12X, center1.y + half1.y),
      vec2(neck12X, center2.y - half2.y),
      neckRadius
    );
    float disconnected = disconnectionAmount();
    neck01 = mix(neck01, 100000.0, disconnected);
    neck12 = mix(neck12, 100000.0, disconnected);

    float about = smoothUnion(blob0, blob1, minimumSide * 0.018);
    about = smoothUnion(about, blob2, minimumSide * 0.018);
    about = smoothUnion(about, neck01, minimumSide * 0.024);
    about = smoothUnion(about, neck12, minimumSide * 0.024);
    vec2 downloadCenter = downloadGlassCenter();
    vec2 downloadHalfSize = u_resolution * vec2(0.225, 0.44);
    float downloadGlass = roundedBoxSdf(
      pixel - downloadCenter,
      downloadHalfSize,
      minimumSide * 0.072
    );
    vec2 communityCenter = communityGlassCenter();
    vec2 communityHalfSize = u_resolution * vec2(0.22, 0.13);
    float communityGlass = roundedBoxSdf(
      pixel - communityCenter,
      communityHalfSize,
      minimumSide * 0.065
    );
    float stagedGlass = mix(mix(home, about, u_transition), downloadGlass, u_downloadTransition);
    float communityCenterGlass = mix(downloadGlass, communityGlass, u_communityTransition);
    float community = min(communityCenterGlass, communityCardsSdf(pixel));
    float support = supportButtonsSdf(pixel);
    float communityStage = mix(stagedGlass, community, smoothstep(0.0, 0.03, u_communityTransition));
    /* 只在裂变起点短距离交接 SDF，避免远距离线性混合把整屏误判为玻璃。 */
    return mix(communityStage, support, smoothstep(0.0, 0.08, u_supportTransition));
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
    float minimumSide = min(u_resolution.x, u_resolution.y);
    vec2 center = u_resolution * 0.5;
    vec2 halfSize = center - vec2(u_inset);
    vec2 localPosition = pixel - center;
    float sdf = liquidGlassSdf(pixel);
    float supportEdgeBlur = 0.0;
    if (u_supportTransition > 0.001) {
      supportEdgeBlur = supportButtonEdgeBlur(pixel)
        * smoothstep(0.0, 0.08, u_supportTransition);
    }
    float glassMask = 1.0 - smoothstep(
      -26.0 - supportEdgeBlur,
      10.0 + supportEdgeBlur,
      sdf
    );
    vec2 edgeNormal = normalize(vec2(
      liquidGlassSdf(pixel + vec2(1.5, 0.0)) - liquidGlassSdf(pixel - vec2(1.5, 0.0)),
      liquidGlassSdf(pixel + vec2(0.0, 1.5)) - liquidGlassSdf(pixel - vec2(0.0, 1.5))
    ) + vec2(0.0001));
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
    vec3 backgroundSharp = flowingBackground(
      sceneUv,
      u_time * u_motion,
      u_transition,
      u_downloadTransition,
      u_communityTransition,
      u_supportTransition
    );
    vec2 backgroundBlurStep = vec2(mix(7.0, 32.0, u_hoverAmount)) / u_resolution;
    vec3 backgroundSoft = backgroundSharp * 0.20;
    backgroundSoft += flowingBackground(sceneUv + vec2(backgroundBlurStep.x, 0.0), u_time * u_motion, u_transition, u_downloadTransition, u_communityTransition, u_supportTransition) * 0.12;
    backgroundSoft += flowingBackground(sceneUv - vec2(backgroundBlurStep.x, 0.0), u_time * u_motion, u_transition, u_downloadTransition, u_communityTransition, u_supportTransition) * 0.12;
    backgroundSoft += flowingBackground(sceneUv + vec2(0.0, backgroundBlurStep.y), u_time * u_motion, u_transition, u_downloadTransition, u_communityTransition, u_supportTransition) * 0.12;
    backgroundSoft += flowingBackground(sceneUv - vec2(0.0, backgroundBlurStep.y), u_time * u_motion, u_transition, u_downloadTransition, u_communityTransition, u_supportTransition) * 0.12;
    backgroundSoft += flowingBackground(sceneUv + backgroundBlurStep, u_time * u_motion, u_transition, u_downloadTransition, u_communityTransition, u_supportTransition) * 0.08;
    backgroundSoft += flowingBackground(sceneUv - backgroundBlurStep, u_time * u_motion, u_transition, u_downloadTransition, u_communityTransition, u_supportTransition) * 0.08;
    backgroundSoft += flowingBackground(sceneUv + vec2(backgroundBlurStep.x, -backgroundBlurStep.y), u_time * u_motion, u_transition, u_downloadTransition, u_communityTransition, u_supportTransition) * 0.08;
    backgroundSoft += flowingBackground(sceneUv + vec2(-backgroundBlurStep.x, backgroundBlurStep.y), u_time * u_motion, u_transition, u_downloadTransition, u_communityTransition, u_supportTransition) * 0.08;
    vec3 background = mix(backgroundSharp, backgroundSoft, u_hoverAmount);
    float logoPerspective = clamp(1.0 + dot(viewCenter, mouseTilt) * 0.24, 0.76, 1.24);
    vec2 logoUv = viewCenter / logoPerspective + 0.5;
    logoUv += refraction * glassMask - mouseTilt * 0.009;
    vec2 logoBlurRadius = vec2(mix(6.0, 30.0, u_hoverAmount)) / u_resolution;
    vec4 logoSharp = texture2D(u_logoTexture, logoUv);
    vec4 logoSoft = logoSharp * 0.40;
    logoSoft += texture2D(u_logoTexture, logoUv + logoBlurRadius) * 0.15;
    logoSoft += texture2D(u_logoTexture, logoUv - logoBlurRadius) * 0.15;
    logoSoft += texture2D(u_logoTexture, logoUv + vec2(logoBlurRadius.x, -logoBlurRadius.y)) * 0.15;
    logoSoft += texture2D(u_logoTexture, logoUv + vec2(-logoBlurRadius.x, logoBlurRadius.y)) * 0.15;
    vec4 logoLayer = mix(logoSharp, logoSoft, max(glassMask * 0.94, u_hoverAmount));
    vec3 scene = mix(background, logoLayer.rgb, logoLayer.a * 0.90 * (1.0 - u_transition));
    float textPerspective = clamp(1.0 - dot(viewCenter, mouseTilt) * 0.07, 0.95, 1.05);
    vec2 textUv = viewCenter / textPerspective + 0.5;
    textUv += refraction * glassMask * 0.9 + mouseTilt * 0.002;
    vec4 cornerText = texture2D(u_cornerTextTexture, textUv);
    scene = mix(scene, cornerText.rgb, cornerText.a * 0.96);
    vec4 communityText = texture2D(u_communityTextTexture, textUv);
    scene = mix(scene, communityText.rgb, communityText.a * u_communityTransition * 0.96);

    float innerEdge = exp(-abs(sdf) * 0.055) * glassMask;
    float razorEdge = exp(-abs(sdf) * 0.7);
    float topLight = smoothstep(-0.15, 0.72, dot(normalize(pixel - center + vec2(0.001)), normalize(vec2(-0.72, 0.7))));
    float pointerGlow = exp(-pointerDistance * pointerDistance * 27.0) * 0.16 * u_motion;
    float caustic = clamp(abs(waveLight) * 0.05, 0.0, 0.045);
    float refractiveShade = dot(edgeNormal, normalize(vec2(-0.66, 0.75))) * edgeLens;

    vec3 glass = scene * vec3(0.98, 1.0, 1.025);
    glass = mix(glass, vec3(0.192, 0.204, 0.200), mix(0.12, 0.19, u_transition));
    glass += vec3(0.204, 0.329, 0.282) * surface * 0.026;
    glass += vec3(1.0, 1.0, 1.0) * (innerEdge * mix(0.020, 0.052, u_transition) + pointerGlow + caustic);
    glass += vec3(0.38, 0.62, 1.0) * innerEdge * (1.0 - topLight) * 0.024;
    glass += vec3(1.0, 0.99, 0.96) * razorEdge * topLight * 0.075;
    glass += vec3(0.76, 0.94, 1.0) * max(refractiveShade, 0.0) * 0.018;
    glass -= vec3(0.10, 0.16, 0.20) * max(-refractiveShade, 0.0) * 0.014;
    glass += vec3(0.82, 0.95, 1.0) * max(waveLight, 0.0) * 0.042;
    glass -= vec3(0.12, 0.20, 0.32) * max(-waveLight, 0.0) * 0.055;

    float outerShadow = smoothstep(46.0, 1.0, sdf) * step(0.0, sdf);
    vec3 color = scene * (1.0 - outerShadow * mix(0.030, 0.085, u_transition));
    color = mix(color, glass, glassMask);

    color = 1.0 - exp(-color * 1.22);
    color = pow(color, vec3(0.94));

    /* 文本使用玻璃中心的完整位移与缩放反解采样，保持拖拽、水波和悬浮同步。 */
    vec2 featureUv = uv + refraction * glassMask * 1.35;
    vec2 base0 = vec2(0.24, 0.21);
    vec2 base1 = vec2(0.50, 0.52);
    vec2 base2 = vec2(0.76, 0.83);
    vec2 motion0 = blobCenter(0.0) / u_resolution - base0;
    vec2 motion1 = blobCenter(1.0) / u_resolution - base1;
    vec2 motion2 = blobCenter(2.0) / u_resolution - base2;
    float scale0 = 1.0 + selectedBlob(0.0) * u_hoverAmount * 0.22;
    float scale1 = 1.0 + selectedBlob(1.0) * u_hoverAmount * 0.22;
    float scale2 = 1.0 + selectedBlob(2.0) * u_hoverAmount * 0.22;
    vec4 feature0 = texture2D(u_glassTextTexture, base0 + (featureUv - motion0 - base0) / scale0);
    vec4 feature1 = texture2D(u_glassTextTexture, base1 + (featureUv - motion1 - base1) / scale1);
    vec4 feature2 = texture2D(u_glassTextTexture, base2 + (featureUv - motion2 - base2) / scale2);
    float featureMask0 = 1.0 - smoothstep(-8.0, 14.0, roundedBoxSdf(pixel - blobCenter(0.0), blobHalfSize(0.0), minimumSide * 0.055));
    float featureMask1 = 1.0 - smoothstep(-8.0, 14.0, roundedBoxSdf(pixel - blobCenter(1.0), blobHalfSize(1.0), minimumSide * 0.061));
    float featureMask2 = 1.0 - smoothstep(-8.0, 14.0, roundedBoxSdf(pixel - blobCenter(2.0), blobHalfSize(2.0), minimumSide * 0.055));
    float aboutTextVisibility = 1.0 - u_downloadTransition;
    color = mix(color, feature0.rgb, feature0.a * featureMask0 * aboutTextVisibility);
    color = mix(color, feature1.rgb, feature1.a * featureMask1 * aboutTextVisibility);
    color = mix(color, feature2.rgb, feature2.a * featureMask2 * aboutTextVisibility);

    vec2 downloadCenter = downloadGlassCenter();
    vec2 downloadMotion = downloadCenter / u_resolution - vec2(0.265, 0.50);
    vec4 downloadFeature = texture2D(u_downloadTextTexture, featureUv - downloadMotion);
    vec2 downloadHalfSize = u_resolution * vec2(0.225, 0.44);
    float downloadFeatureMask = 1.0 - smoothstep(
      -8.0,
      14.0,
      roundedBoxSdf(
        pixel - downloadCenter,
        downloadHalfSize,
        minimumSide * 0.072
      )
    );
    color = mix(
      color,
      downloadFeature.rgb,
      downloadFeature.a * downloadFeatureMask * u_downloadTransition * (1.0 - u_communityTransition)
    );

    /* 六组按钮文字按各自玻璃中心重新采样，浮动与水波折射始终同步。 */
    for (int index = 0; index < 6; index++) {
      float supportIndex = float(index);
      float stackIndex = mod(supportIndex, 3.0);
      float onLeft = 1.0 - step(2.5, supportIndex);
      vec2 base = mix(
        vec2(0.77, 0.84 - stackIndex * 0.105),
        vec2(0.23, 0.36 - stackIndex * 0.105),
        onLeft
      );
      vec2 motion = supportButtonCenter(supportIndex) / u_resolution - base;
      vec2 supportSampleUv = featureUv - motion;
      float supportSourceMask = 1.0 - smoothstep(
        -4.0,
        8.0,
        roundedBoxSdf(
          supportSampleUv * u_resolution - base * u_resolution,
          u_resolution * vec2(0.135, 0.046),
          minimumSide * 0.025
        )
      );
      float supportMask = 1.0 - smoothstep(
        -8.0,
        14.0,
        roundedBoxSdf(
          pixel - supportButtonCenter(supportIndex),
          u_resolution * vec2(0.145, 0.085) * supportButtonScale(supportIndex),
          minimumSide * 0.060 * supportButtonScale(supportIndex)
        )
      );
      if (supportSourceMask > 0.001 && supportMask > 0.001) {
        vec4 supportFeature = sampleSupportText(
          supportSampleUv,
          supportButtonBlurPx(supportIndex)
        );
        color = mix(
          color,
          supportFeature.rgb,
          supportFeature.a * supportSourceMask * supportMask * u_supportTransition
        );
      }
    }

    /* 英雄字在色调映射后以折射坐标合成，保留原渐变并继续响应水波。 */
    vec4 heroText = texture2D(u_textTexture, textUv);
    color = mix(color, heroText.rgb, heroText.a * 0.96);

    gl_FragColor = vec4(color, 1.0);
  }
`;
