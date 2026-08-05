'use client';

import { gsap } from 'gsap';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { createAboutFeatures } from '../website-experience/about/about-content';
import { createDownloadContent } from '../website-experience/download/download-content';
import {
  LIQUID_GLASS_FRAGMENT_SHADER,
  LIQUID_GLASS_VERTEX_SHADER
} from './liquid-glass-shaders';
import styles from './liquid-glass-home.module.css';

export const LIQUID_GLASS_RIPPLE_EVENT = 'ai-pet-liquid-ripple';
export const LIQUID_GLASS_INTERACTION_EVENT = 'ai-pet-liquid-interaction';

interface LiquidGlassHomeProps {
  active: boolean;
  isPaused: boolean;
  reducedMotion: boolean;
  transitionProgress?: number;
}

interface RippleEventDetail {
  clientX: number;
  clientY: number;
  strength: number;
}

export interface LiquidGlassInteractionDetail {
  hovered: -1 | 0 | 1 | 2;
  dragging: boolean;
  offsets: readonly [number, number, number, number, number, number];
}

/**
 * 将液态玻璃原型封装为首页稳定态叶子组件，离开首页时完整释放 GPU 与动画资源。
 */
export function LiquidGlassHome({
  active,
  isPaused,
  reducedMotion,
  transitionProgress = 0
}: LiquidGlassHomeProps) {
  const { t } = useI18n();
  const glassFeatures = useMemo(() => {
    const featureMap = new Map(createAboutFeatures(t).map(feature => [feature.id, feature]));
    return [
      featureMap.get('text-editor')!,
      featureMap.get('companion-chat')!,
      featureMap.get('file-management')!
    ];
  }, [t]);
  const downloadGlassCopy = useMemo(() => {
    const content = createDownloadContent(t);
    return {
      faqBody: content.faqItems
        .slice(0, 3)
        .map((item) => `• ${item.question}\n  ${item.answer}`)
        .join('\n\n'),
      faqTitle: t('download.faq.label'),
      noticeBody: content.installNoticeItems
        .map((item) => `• ${item.title}\n  ${item.body}`)
        .join('\n\n'),
      noticeTitle: t('download.notice.label')
    };
  }, [t]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(isPaused);
  const transitionRef = useRef(transitionProgress);
  const [initializationFailed, setInitializationFailed] = useState(false);

  useEffect(() => {
    pausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    transitionRef.current = transitionProgress;
  }, [transitionProgress]);

  useEffect(() => {
    if (!active) return;

    const canvas = canvasRef.current;
    const gl = canvas?.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      desynchronized: true,
      powerPreference: 'high-performance'
    });
    if (!canvas || !gl) {
      setInitializationFailed(true);
      return;
    }

    let disposed = false;
    let renderedStaticFrame = false;
    let currentTime = 0;
    let initializedViewport = false;
    let inset = 48;
    let radius = 62;
    let rippleIndex = 0;
    let downloadTypingStartedAt = -1;
    let lastTypedCharacters = -1;
    const downloadTypingLength = Object.values(downloadGlassCopy)
      .reduce((total, text) => total + Array.from(text).length, 0);
    const pointer = { x: 0.5, y: 0.5 };
    const glassInteraction = { hoverAmount: 0, hovered: -1, dragging: false };
    const blobOffsets = new Float32Array(6);
    const rippleData = new Float32Array(6 * 4);
    const createdTextures: WebGLTexture[] = [];
    const createdBuffers: WebGLBuffer[] = [];
    const createdShaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;

    for (let index = 0; index < 6; index += 1) {
      rippleData[index * 4 + 2] = -100;
    }

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('无法创建 WebGL 着色器');
      createdShaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`着色器编译失败：${gl.getShaderInfoLog(shader) ?? '未知错误'}`);
      }
      return shader;
    };

    const createTexture = () => {
      const texture = gl.createTexture();
      if (!texture) throw new Error('无法创建 WebGL 纹理');
      createdTextures.push(texture);
      return texture;
    };

    const pointerX = gsap.quickTo(pointer, 'x', {
      duration: 0.38,
      ease: 'power3.out'
    });
    const pointerY = gsap.quickTo(pointer, 'y', {
      duration: 0.38,
      ease: 'power3.out'
    });
    let render = (_time: number) => {};
    let resize = () => {};
    let updateLogoTexture = (_width: number, _height: number) => {};

    try {
      const vertexShader = compileShader(gl.VERTEX_SHADER, LIQUID_GLASS_VERTEX_SHADER);
      const fragmentShader = compileShader(gl.FRAGMENT_SHADER, LIQUID_GLASS_FRAGMENT_SHADER);
      program = gl.createProgram();
      if (!program) throw new Error('无法创建 WebGL 程序');
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`着色器链接失败：${gl.getProgramInfoLog(program) ?? '未知错误'}`);
      }
      gl.useProgram(program);

      const positions = gl.createBuffer();
      if (!positions) throw new Error('无法创建 WebGL 顶点缓冲');
      createdBuffers.push(positions);
      gl.bindBuffer(gl.ARRAY_BUFFER, positions);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        -1, 1,
        1, -1,
        1, 1
      ]), gl.STATIC_DRAW);

      const positionLocation = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      const uniforms = {
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        pointer: gl.getUniformLocation(program, 'u_pointer'),
        time: gl.getUniformLocation(program, 'u_time'),
        inset: gl.getUniformLocation(program, 'u_inset'),
        radius: gl.getUniformLocation(program, 'u_radius'),
        motion: gl.getUniformLocation(program, 'u_motion'),
        transition: gl.getUniformLocation(program, 'u_transition'),
        downloadTransition: gl.getUniformLocation(program, 'u_downloadTransition'),
        blobOffsets: gl.getUniformLocation(program, 'u_blobOffsets[0]'),
        hoveredBlob: gl.getUniformLocation(program, 'u_hoveredBlob'),
        hoverAmount: gl.getUniformLocation(program, 'u_hoverAmount'),
        dragging: gl.getUniformLocation(program, 'u_dragging'),
        rippleActivity: gl.getUniformLocation(program, 'u_rippleActivity'),
        ripples: gl.getUniformLocation(program, 'u_ripples[0]'),
        logoTexture: gl.getUniformLocation(program, 'u_logoTexture'),
        textTexture: gl.getUniformLocation(program, 'u_textTexture'),
        cornerTextTexture: gl.getUniformLocation(program, 'u_cornerTextTexture'),
        glassTextTexture: gl.getUniformLocation(program, 'u_glassTextTexture'),
        downloadTextTexture: gl.getUniformLocation(program, 'u_downloadTextTexture')
      };

      const logoCanvas = document.createElement('canvas');
      const logoContext = logoCanvas.getContext('2d');
      const textCanvas = document.createElement('canvas');
      const textContext = textCanvas.getContext('2d');
      const cornerTextCanvas = document.createElement('canvas');
      const cornerTextContext = cornerTextCanvas.getContext('2d');
      const glassTextCanvas = document.createElement('canvas');
      const glassTextContext = glassTextCanvas.getContext('2d');
      const downloadTextCanvas = document.createElement('canvas');
      const downloadTextContext = downloadTextCanvas.getContext('2d');
      if (
        !logoContext
        || !textContext
        || !cornerTextContext
        || !glassTextContext
        || !downloadTextContext
      ) {
        throw new Error('无法创建首页纹理画布');
      }

      const logoTexture = createTexture();
      const textTexture = createTexture();
      const cornerTextTexture = createTexture();
      const glassTextTexture = createTexture();
      const downloadTextTexture = createTexture();
      const logoImage = new Image();
      let logoReady = false;
      let lastTextProgress = -1;

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, logoTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0])
      );
      gl.uniform1i(uniforms.logoTexture, 1);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.uniform1i(uniforms.textTexture, 0);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, cornerTextTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.uniform1i(uniforms.cornerTextTexture, 2);

      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, glassTextTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.uniform1i(uniforms.glassTextTexture, 3);

      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, downloadTextTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.uniform1i(uniforms.downloadTextTexture, 4);

      const updateTextTexture = (
        width: number,
        height: number,
        transition: number,
        downloadTransition: number,
        typedCharacters: number,
        staticLayersChanged: boolean
      ) => {
        if (staticLayersChanged) {
          textCanvas.width = width;
          textCanvas.height = height;
          cornerTextCanvas.width = width;
          cornerTextCanvas.height = height;
          textContext.clearRect(0, 0, width, height);
          cornerTextContext.clearRect(0, 0, width, height);
        }
        if (glassTextCanvas.width !== width || glassTextCanvas.height !== height) {
          glassTextCanvas.width = width;
          glassTextCanvas.height = height;
        }
        if (downloadTextCanvas.width !== width || downloadTextCanvas.height !== height) {
          downloadTextCanvas.width = width;
          downloadTextCanvas.height = height;
        }
        glassTextContext.clearRect(0, 0, width, height);
        downloadTextContext.clearRect(0, 0, width, height);

        let fontSize = Math.min(width * 0.235, height * 0.40);
        const gradient = textContext.createLinearGradient(width * 0.18, 0, width * 0.82, 0);
        gradient.addColorStop(0, '#BDFCF5');
        gradient.addColorStop(0.28, '#CFF8D5');
        gradient.addColorStop(0.52, '#F6F7A7');
        gradient.addColorStop(0.74, '#FFE6BD');
        gradient.addColorStop(1, '#F7DCC8');

        const setHeroFont = (size: number) => {
          textContext.font = `900 ${size}px "Arial Black", "Segoe UI", sans-serif`;
        };
        setHeroFont(fontSize);
        const measuredWidth = textContext.measureText('AI PET').width;
        if (measuredWidth > width * 0.80) {
          fontSize *= width * 0.80 / measuredWidth;
          setHeroFont(fontSize);
        }
        textContext.textAlign = 'center';
        textContext.textBaseline = 'middle';
        const originalWidth = textContext.measureText('AI PET').width;
        const aiWidth = textContext.measureText('AI').width;
        const petWidth = textContext.measureText('PET').width;
        const mix = (from: number, to: number, amount = transition) => (
          from + ((to - from) * amount)
        );
        const aboutPositions = [
          {
            text: 'AI',
            x: mix(
              (width - originalWidth + aiWidth) * 0.5,
              aiWidth * 0.5 + width * 0.065
            ),
            y: mix(height * 0.5, fontSize * 0.52 + height * 0.05)
          },
          {
            text: 'PET',
            x: mix(
              (width + originalWidth - petWidth) * 0.5,
              width - petWidth * 0.5 - width * 0.065
            ),
            y: mix(height * 0.5, height - fontSize * 0.52 - height * 0.05)
          }
        ];

        const downloadFontSize = Math.min(width * 0.082, height * 0.14);
        setHeroFont(downloadFontSize);
        const downloadAiWidth = textContext.measureText('AI').width;
        const downloadPetWidth = textContext.measureText('PET').width;
        const downloadGap = downloadFontSize * 0.20;
        const downloadTotalWidth = downloadAiWidth + downloadGap + downloadPetWidth;
        const downloadCenterX = width * 0.255;
        const downloadY = height * 0.255;
        const finalPositions = [
          downloadCenterX - downloadTotalWidth * 0.5 + downloadAiWidth * 0.5,
          downloadCenterX + downloadTotalWidth * 0.5 - downloadPetWidth * 0.5
        ];
        const currentFontSize = mix(fontSize, downloadFontSize, downloadTransition);
        const positions = aboutPositions.map((position, index) => ({
          ...position,
          x: mix(position.x, finalPositions[index]!, downloadTransition),
          y: mix(position.y, downloadY, downloadTransition)
        }));

        const drawText = (text: string, x: number, y: number, alpha: number) => {
          setHeroFont(currentFontSize);
          textContext.globalAlpha = alpha;
          textContext.fillStyle = 'rgba(4, 10, 11, 0.52)';
          textContext.shadowColor = 'rgba(2, 7, 8, 0.72)';
          textContext.shadowBlur = Math.max(10, currentFontSize * 0.10);
          textContext.shadowOffsetX = currentFontSize * 0.018;
          textContext.shadowOffsetY = currentFontSize * 0.055;
          textContext.fillText(text, x, y);
          textContext.fillStyle = gradient;
          textContext.shadowColor = 'transparent';
          textContext.shadowBlur = 0;
          textContext.shadowOffsetX = 0;
          textContext.shadowOffsetY = 0;
          textContext.fillText(text, x, y);
        };

        // 两段文字从首页原始字位连续移动，避免滚轮中间态出现叠字或跳帧。
        positions.forEach(({ text, x, y }) => drawText(text, x, y, 1));
        textContext.globalAlpha = 1;

        let cornerFontSize = Math.min(width * 0.13, height * 0.26);
        cornerTextContext.font = `900 ${cornerFontSize}px "Arial Black", "Segoe UI", sans-serif`;
        const widestCornerWord = Math.max(
          cornerTextContext.measureText('AGENT').width,
          cornerTextContext.measureText('YOUR').width
        );
        if (widestCornerWord > width * 0.45) {
          cornerFontSize *= width * 0.45 / widestCornerWord;
          cornerTextContext.font = `900 ${cornerFontSize}px "Arial Black", "Segoe UI", sans-serif`;
        }
        const agentWidth = cornerTextContext.measureText('AGENT').width;
        const yourWidth = cornerTextContext.measureText('YOUR').width;
        /** 四角新字只跟随滚轮横向滑入，不使用透明度渐变。 */
        const agentX = mix(width + agentWidth + width * 0.02, width * 0.94);
        const yourX = mix(-yourWidth - width * 0.02, width * 0.06);
        const agentY = mix(
          cornerFontSize * 0.52 + height * 0.05,
          -cornerFontSize,
          downloadTransition
        );
        const yourY = mix(
          height - cornerFontSize * 0.52 - height * 0.05,
          height + cornerFontSize,
          downloadTransition
        );
        const agentGradient = cornerTextContext.createLinearGradient(width * 0.5, 0, width * 0.94, 0);
        agentGradient.addColorStop(0, '#BDFCF5');
        agentGradient.addColorStop(0.55, '#CFF8D5');
        agentGradient.addColorStop(1, '#F6F7A7');
        const yourGradient = cornerTextContext.createLinearGradient(width * 0.06, 0, width * 0.45, 0);
        yourGradient.addColorStop(0, '#F6F7A7');
        yourGradient.addColorStop(0.52, '#FFE6BD');
        yourGradient.addColorStop(1, '#F7DCC8');
        cornerTextContext.textBaseline = 'middle';
        cornerTextContext.globalAlpha = 1;
        cornerTextContext.fillStyle = 'rgba(4, 10, 11, 0.52)';
        cornerTextContext.shadowColor = 'rgba(2, 7, 8, 0.72)';
        cornerTextContext.shadowBlur = Math.max(14, cornerFontSize * 0.1);
        cornerTextContext.shadowOffsetY = cornerFontSize * 0.05;
        cornerTextContext.textAlign = 'right';
        cornerTextContext.fillText(
          'AGENT',
          agentX,
          agentY
        );
        cornerTextContext.textAlign = 'left';
        cornerTextContext.fillText(
          'YOUR',
          yourX,
          yourY
        );
        cornerTextContext.fillStyle = agentGradient;
        cornerTextContext.shadowColor = 'transparent';
        cornerTextContext.shadowBlur = 0;
        cornerTextContext.textAlign = 'right';
        cornerTextContext.fillText(
          'AGENT',
          agentX,
          agentY
        );
        cornerTextContext.textAlign = 'left';
        cornerTextContext.fillStyle = yourGradient;
        cornerTextContext.fillText(
          'YOUR',
          yourX,
          yourY
        );
        cornerTextContext.globalAlpha = 1;

        /** 三项主介绍直接绘制进 WebGL 纹理，才能随玻璃位移并接受水波折射。 */
        const drawGlassFeature = (
          feature: typeof glassFeatures[number],
          x: number,
          y: number,
          maxWidth: number
        ) => {
          const minimumSide = Math.min(width, height);
          const fitFont = (weight: number, desiredSize: number, text: string) => {
            let size = desiredSize;
            glassTextContext.font = `${weight} ${size}px "Segoe UI", Arial, sans-serif`;
            const measured = glassTextContext.measureText(text).width;
            if (measured > maxWidth) size *= maxWidth / measured;
            glassTextContext.font = `${weight} ${size}px "Segoe UI", Arial, sans-serif`;
          };
          glassTextContext.textAlign = 'left';
          glassTextContext.textBaseline = 'top';
          glassTextContext.shadowColor = 'rgba(0, 0, 0, 0.82)';
          glassTextContext.shadowBlur = Math.max(4, minimumSide * 0.006);
          glassTextContext.shadowOffsetY = Math.max(1, minimumSide * 0.002);
          glassTextContext.fillStyle = '#D7FFF9';
          fitFont(780, Math.max(9, minimumSide * 0.014), feature.eyebrow);
          glassTextContext.fillText(feature.eyebrow.toUpperCase(), x, y);
          glassTextContext.fillStyle = '#FFF6AC';
          fitFont(760, Math.max(19, minimumSide * 0.031), feature.title);
          glassTextContext.fillText(feature.title, x, y + minimumSide * 0.028);
          glassTextContext.fillStyle = '#FFFFFF';
          fitFont(450, Math.max(11, minimumSide * 0.016), feature.summary);
          glassTextContext.fillText(feature.summary, x, y + minimumSide * 0.072);
          glassTextContext.fillStyle = '#E9FFF7';
          feature.details.slice(0, 2).forEach((detail, index) => {
            const line = `• ${detail}`;
            fitFont(520, Math.max(10, minimumSide * 0.0145), line);
            glassTextContext.fillText(line, x, y + minimumSide * (0.102 + index * 0.025));
          });
          glassTextContext.shadowColor = 'transparent';
          glassTextContext.shadowBlur = 0;
          glassTextContext.shadowOffsetY = 0;
        };
        glassTextContext.globalAlpha = Math.max(0, Math.min(
          1,
          (transition - 0.14) * 1.17
        )) * (1 - downloadTransition);
        drawGlassFeature(glassFeatures[0]!, width * 0.065, height * 0.68, width * 0.33);
        drawGlassFeature(glassFeatures[1]!, width * 0.29, height * 0.405, width * 0.40);
        drawGlassFeature(glassFeatures[2]!, width * 0.60, height * 0.12, width * 0.33);
        glassTextContext.globalAlpha = 1;

        /** 下载文案使用独立纹理，逐字出现并只由下载玻璃采样。 */
        let remainingCharacters = typedCharacters;
        const revealCharacters = (text: string) => {
          const characters = Array.from(text);
          const visible = characters.slice(0, Math.max(0, remainingCharacters)).join('');
          remainingCharacters -= characters.length;
          return visible;
        };
        const visibleNoticeTitle = revealCharacters(downloadGlassCopy.noticeTitle);
        const visibleNoticeBody = revealCharacters(downloadGlassCopy.noticeBody);
        const visibleFaqTitle = revealCharacters(downloadGlassCopy.faqTitle);
        const visibleFaqBody = revealCharacters(downloadGlassCopy.faqBody);
        const minimumSide = Math.min(width, height);

        const drawWrappedText = (
          text: string,
          x: number,
          y: number,
          maxWidth: number,
          lineHeight: number
        ) => {
          let line = '';
          let cursorY = y;
          for (const character of text) {
            if (character === '\n') {
              if (line) downloadTextContext.fillText(line, x, cursorY);
              line = '';
              cursorY += lineHeight * 1.45;
              continue;
            }
            const candidate = line + character;
            if (line && downloadTextContext.measureText(candidate).width > maxWidth) {
              downloadTextContext.fillText(line, x, cursorY);
              line = character;
              cursorY += lineHeight;
            } else {
              line = candidate;
            }
          }
          if (line) downloadTextContext.fillText(line, x, cursorY);
        };

        const drawDownloadColumn = (
          title: string,
          body: string,
          x: number,
          maxWidth: number
        ) => {
          const startY = height * 0.465;
          downloadTextContext.textAlign = 'left';
          downloadTextContext.textBaseline = 'top';
          downloadTextContext.shadowColor = 'rgba(0, 0, 0, 0.92)';
          downloadTextContext.shadowBlur = Math.max(5, minimumSide * 0.0065);
          downloadTextContext.shadowOffsetY = Math.max(1, minimumSide * 0.002);
          downloadTextContext.fillStyle = '#FFF6AC';
          downloadTextContext.font = `780 ${Math.max(18, minimumSide * 0.028)}px "Segoe UI", Arial, sans-serif`;
          downloadTextContext.fillText(title, x, startY);
          downloadTextContext.fillStyle = '#FFFFFF';
          downloadTextContext.font = `560 ${Math.max(11, minimumSide * 0.015)}px "Segoe UI", Arial, sans-serif`;
          drawWrappedText(
            body,
            x,
            startY + minimumSide * 0.058,
            maxWidth,
            Math.max(16, minimumSide * 0.023)
          );
          downloadTextContext.shadowColor = 'transparent';
          downloadTextContext.shadowBlur = 0;
          downloadTextContext.shadowOffsetY = 0;
        };

        downloadTextContext.globalAlpha = downloadTransition;
        drawDownloadColumn(
          visibleNoticeTitle,
          visibleNoticeBody,
          width * 0.065,
          width * 0.185
        );
        drawDownloadColumn(
          visibleFaqTitle,
          visibleFaqBody,
          width * 0.275,
          width * 0.185
        );
        downloadTextContext.globalAlpha = 1;

        if (staticLayersChanged) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, textTexture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, cornerTextTexture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            cornerTextCanvas
          );
        }
        if (staticLayersChanged) {
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, glassTextTexture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            glassTextCanvas
          );
        }
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, downloadTextTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          downloadTextCanvas
        );
        lastTextProgress = transition + downloadTransition;
        lastTypedCharacters = typedCharacters;
      };

      updateLogoTexture = (width: number, height: number) => {
        if (!logoReady) return;
        logoCanvas.width = width;
        logoCanvas.height = height;
        logoContext.clearRect(0, 0, width, height);

        const source = { x: 450, y: 35, width: 560, height: 670 };
        const maxWidth = width * (width < height ? 0.86 : 0.78);
        const maxHeight = height * 0.92;
        const scale = Math.min(maxWidth / source.width, maxHeight / source.height);
        const targetWidth = source.width * scale;
        const targetHeight = source.height * scale;
        logoContext.drawImage(
          logoImage,
          source.x,
          source.y,
          source.width,
          source.height,
          (width - targetWidth) * 0.5,
          (height - targetHeight) * 0.5,
          targetWidth,
          targetHeight
        );

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, logoTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, logoCanvas);
      };

      resize = () => {
        const resolutionScale = window.innerWidth >= 2400
          ? 0.65
          : window.innerWidth >= 1600
            ? 0.8
            : window.innerWidth >= 1200
              ? 0.9
              : 1;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, resolutionScale);
        const width = Math.round(window.innerWidth * pixelRatio);
        const height = Math.round(window.innerHeight * pixelRatio);

        const sizeChanged = canvas.width !== width || canvas.height !== height;
        if (sizeChanged) {
          canvas.width = width;
          canvas.height = height;
        }

        // 同一 Canvas 的 WebGL 资源在章节离场时会释放；返回首页即使尺寸不变，
        // 也必须为新程序恢复视口并重新上传全部纹理，避免首帧只剩黑色背景。
        if (!initializedViewport || sizeChanged) {
          gl.viewport(0, 0, width, height);
          updateLogoTexture(width, height);
          const rawTransition = transitionRef.current;
          updateTextTexture(
            width,
            height,
            Math.min(1, rawTransition),
            Math.min(1, Math.max(0, rawTransition - 1)),
            Math.max(0, lastTypedCharacters),
            true
          );
          renderedStaticFrame = false;
          initializedViewport = true;
        }

        inset = Math.min(
          64,
          Math.max(window.innerWidth < 640 ? 13 : 16, window.innerWidth * 0.04)
        ) * pixelRatio;
        radius = Math.min(82, Math.max(30, window.innerWidth * 0.048)) * pixelRatio;
      };

      const addRipple = (x: number, y: number, strength = 1) => {
        const offset = rippleIndex * 4;
        rippleData[offset] = x;
        rippleData[offset + 1] = y;
        rippleData[offset + 2] = currentTime;
        rippleData[offset + 3] = strength;
        rippleIndex = (rippleIndex + 1) % 6;
      };
      const isInsideGlass = (x: number, y: number) => {
        const insetCss = Math.min(
          64,
          Math.max(window.innerWidth < 640 ? 13 : 16, window.innerWidth * 0.04)
        );
        return x > insetCss
          && x < window.innerWidth - insetCss
          && y > insetCss
          && y < window.innerHeight - insetCss;
      };
      const updatePointer = (event: PointerEvent, forceRipple = false) => {
        if (reducedMotion || !isInsideGlass(event.clientX, event.clientY)) return;
        const x = event.clientX / window.innerWidth;
        const y = 1 - event.clientY / window.innerHeight;
        pointerX(x);
        pointerY(y);
        if (forceRipple) addRipple(x, y, 1.65);
      };
      const handleCanvasPointerDown = (event: PointerEvent) => updatePointer(event, true);
      const handleControlRipple = (event: Event) => {
        if (reducedMotion) return;
        const detail = (event as CustomEvent<RippleEventDetail>).detail;
        if (!detail) return;
        const x = detail.clientX / window.innerWidth;
        const y = 1 - detail.clientY / window.innerHeight;
        pointerX(x);
        pointerY(y);
        addRipple(x, y, detail.strength);
      };
      const handleGlassInteraction = (event: Event) => {
        const detail = (event as CustomEvent<LiquidGlassInteractionDetail>).detail;
        if (!detail) return;
        glassInteraction.hovered = detail.hovered;
        glassInteraction.dragging = detail.dragging;
        gsap.to(glassInteraction, {
          hoverAmount: detail.hovered >= 0 ? 1 : 0,
          duration: detail.hovered >= 0 ? 0.32 : 1.1,
          ease: 'power3.out',
          overwrite: 'auto'
        });
        blobOffsets.set(detail.offsets);
        renderedStaticFrame = false;
      };

      render = (time: number) => {
        if (disposed || pausedRef.current || (reducedMotion && renderedStaticFrame)) return;
        currentTime = reducedMotion ? 12 : time;
        const rawTransition = transitionRef.current;
        const transition = Math.min(1, rawTransition);
        const downloadTransition = Math.min(1, Math.max(0, rawTransition - 1));
        let typedCharacters = 0;
        if (downloadTransition > 0.38) {
          if (downloadTypingStartedAt < 0) downloadTypingStartedAt = currentTime;
          typedCharacters = reducedMotion
            ? downloadTypingLength
            : Math.min(
                downloadTypingLength,
                Math.floor((currentTime - downloadTypingStartedAt) * 42)
              );
        } else {
          downloadTypingStartedAt = -1;
        }
        const staticLayersChanged = Math.abs(rawTransition - lastTextProgress) > 0.002;
        if (staticLayersChanged || typedCharacters !== lastTypedCharacters) {
          updateTextTexture(
            canvas.width,
            canvas.height,
            transition,
            downloadTransition,
            typedCharacters,
            staticLayersChanged
          );
        }
        gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
        gl.uniform2f(uniforms.pointer, pointer.x, pointer.y);
        gl.uniform1f(uniforms.time, currentTime);
        gl.uniform1f(uniforms.inset, inset);
        gl.uniform1f(uniforms.radius, radius);
        gl.uniform1f(uniforms.motion, reducedMotion ? 0 : 1);
        gl.uniform1f(uniforms.transition, transition);
        gl.uniform1f(uniforms.downloadTransition, downloadTransition);
        gl.uniform2fv(uniforms.blobOffsets, blobOffsets);
        gl.uniform1f(uniforms.hoveredBlob, glassInteraction.hovered);
        gl.uniform1f(uniforms.hoverAmount, glassInteraction.hoverAmount);
        gl.uniform1f(uniforms.dragging, glassInteraction.dragging ? 1 : 0);
        let rippleActivity = 0;
        for (let index = 0; index < 6; index += 1) {
          const offset = index * 4;
          const age = currentTime - rippleData[offset + 2]!;
          if (age > 0 && age < 4.2 && rippleData[offset + 3]! > 0) {
            rippleActivity = Math.max(rippleActivity, 1 - age / 4.2);
          }
        }
        gl.uniform1f(uniforms.rippleActivity, rippleActivity);
        gl.uniform4fv(uniforms.ripples, rippleData);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        renderedStaticFrame = reducedMotion;
      };
      const handleVisibilityChange = () => {
        if (document.hidden) {
          gsap.ticker.remove(render);
        } else {
          gsap.ticker.add(render);
        }
      };
      const handleLogoLoad = () => {
        if (disposed) return;
        logoReady = true;
        updateLogoTexture(canvas.width, canvas.height);
        renderedStaticFrame = false;
        render(currentTime);
      };
      const handleLogoError = () => {
        if (disposed) return;
        setInitializationFailed(true);
      };

      logoImage.addEventListener('load', handleLogoLoad);
      logoImage.addEventListener('error', handleLogoError);
      logoImage.src = '/AP.png';
      resize();
      gsap.ticker.lagSmoothing(500, 33);
      gsap.ticker.add(render);
      window.addEventListener('resize', resize, { passive: true });
      window.addEventListener('pointermove', updatePointer, { passive: true });
      window.addEventListener(LIQUID_GLASS_RIPPLE_EVENT, handleControlRipple);
      window.addEventListener(LIQUID_GLASS_INTERACTION_EVENT, handleGlassInteraction);
      canvas.addEventListener('pointerdown', handleCanvasPointerDown, { passive: true });
      document.addEventListener('visibilitychange', handleVisibilityChange);

      return () => {
        disposed = true;
        gsap.ticker.remove(render);
        gsap.killTweensOf(pointer);
        gsap.killTweensOf(glassInteraction);
        window.removeEventListener('resize', resize);
        window.removeEventListener('pointermove', updatePointer);
        window.removeEventListener(LIQUID_GLASS_RIPPLE_EVENT, handleControlRipple);
        window.removeEventListener(LIQUID_GLASS_INTERACTION_EVENT, handleGlassInteraction);
        canvas.removeEventListener('pointerdown', handleCanvasPointerDown);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        logoImage.removeEventListener('load', handleLogoLoad);
        logoImage.removeEventListener('error', handleLogoError);
        createdTextures.forEach(texture => gl.deleteTexture(texture));
        createdBuffers.forEach(buffer => gl.deleteBuffer(buffer));
        createdShaders.forEach(shader => gl.deleteShader(shader));
        if (program) gl.deleteProgram(program);
      };
    } catch {
      disposed = true;
      gsap.killTweensOf(pointer);
      gsap.killTweensOf(glassInteraction);
      createdTextures.forEach(texture => gl.deleteTexture(texture));
      createdBuffers.forEach(buffer => gl.deleteBuffer(buffer));
      createdShaders.forEach(shader => gl.deleteShader(shader));
      if (program) gl.deleteProgram(program);
      setInitializationFailed(true);
    }
  }, [active, downloadGlassCopy, glassFeatures, reducedMotion]);

  return (
    <div
      className={styles.surface}
      data-testid="liquid-glass-home"
      data-active={active}
      data-initialization-failed={initializationFailed}
      aria-hidden={!active}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        data-liquid-glass-canvas
        aria-label="AI PET 互动液态玻璃画布"
      />
      <div className={styles.fallback} aria-hidden={!initializationFailed}>
        <span>AI PET</span>
      </div>
    </div>
  );
}
