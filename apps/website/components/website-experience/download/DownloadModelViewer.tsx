'use client';

import { gsap } from 'gsap';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import styles from './download-model-viewer.module.css';

export interface DownloadModelViewerProps {
  active: boolean;
  entryProgress: number;
  modelUrl: string;
  motionDisabled: boolean;
  paused: boolean;
  platformName: string;
}

type ViewerRuntime = {
  camera: THREE.PerspectiveCamera;
  currentModel: THREE.Group | null;
  frame: number | null;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
};

/** 释放 GLB 创建的 GPU 资源，避免平台反复切换后显存持续增长。 */
function disposeModel(model: THREE.Object3D) {
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value instanceof THREE.Texture) value.dispose();
      });
      material.dispose();
    });
  });
}

export function DownloadModelViewer({
  active,
  entryProgress,
  modelUrl,
  motionDisabled,
  paused,
  platformName
}: DownloadModelViewerProps) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<ViewerRuntime | null>(null);
  const activeRef = useRef(active);
  const pausedRef = useRef(paused);
  const entryRef = useRef(entryProgress);
  const rotationRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; startX: number; rotation: number } | null>(null);
  const switchTimelineRef = useRef<gsap.core.Timeline | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadPercent, setLoadPercent] = useState(0);
  const [loadError, setLoadError] = useState('');

  activeRef.current = active;
  pausedRef.current = paused;
  entryRef.current = entryProgress;

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) {
      setLoadError('未找到模型容器');
      setLoadState('error');
      return;
    }

    // 模型使用独立透明画布，首页液态玻璃可在其下方持续渲染真实折射与水波。
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    viewer.prepend(canvas);

    // 拖拽直接绑定实际 WebGL 画布，避免重挂载画布后父级 React 事件命中丢失。
    const beginDrag = (event: PointerEvent) => {
      if (!activeRef.current || event.button !== 0) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      viewer.dataset.dragging = 'true';
      dragRef.current = {
        pointerId: event.pointerId,
        rotation: rotationRef.current,
        startX: event.clientX
      };
    };
    const moveDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      const model = runtimeRef.current?.currentModel;
      if (!drag || drag.pointerId !== event.pointerId || !model) return;
      rotationRef.current = drag.rotation + (event.clientX - drag.startX) * 0.012;
      model.rotation.y = rotationRef.current;
      viewer.dataset.rotation = rotationRef.current.toFixed(4);
    };
    const finishDrag = (event: PointerEvent) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      dragRef.current = null;
      delete viewer.dataset.dragging;
    };
    canvas.addEventListener('pointerdown', beginDrag);
    canvas.addEventListener('pointermove', moveDrag);
    canvas.addEventListener('pointerup', finishDrag);
    canvas.addEventListener('pointercancel', finishDrag);

    let renderer: THREE.WebGLRenderer;
    try {
      // 优先 WebGL1，兼顾旧显卡并降低额外上下文的显存开销。
      const context = canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        depth: true,
        powerPreference: 'default'
      });
      if (!context) throw new Error('当前浏览器无法创建 3D 模型渲染上下文');
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: false,
        canvas,
        context,
        powerPreference: 'default'
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoadState('error');
      return;
    }

    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
    camera.position.set(0, 0.05, 4.4);
    scene.add(new THREE.HemisphereLight(0xeafff9, 0x10131f, 2.4));
    const keyLight = new THREE.DirectionalLight(0xfff1c4, 4.2);
    keyLight.position.set(3.5, 4.5, 5);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xa8dfff, 2.5);
    rimLight.position.set(-4, 1, -2);
    scene.add(rimLight);

    const runtime: ViewerRuntime = {
      camera,
      currentModel: null,
      frame: null,
      renderer,
      scene
    };
    runtimeRef.current = runtime;

    const resize = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const render = () => {
      runtime.frame = null;
      if (!activeRef.current || pausedRef.current) return;
      renderer.render(scene, camera);
      runtime.frame = window.requestAnimationFrame(render);
    };
    if (active) runtime.frame = window.requestAnimationFrame(render);

    return () => {
      observer.disconnect();
      canvas.removeEventListener('pointerdown', beginDrag);
      canvas.removeEventListener('pointermove', moveDrag);
      canvas.removeEventListener('pointerup', finishDrag);
      canvas.removeEventListener('pointercancel', finishDrag);
      if (runtime.frame !== null) window.cancelAnimationFrame(runtime.frame);
      switchTimelineRef.current?.kill();
      if (runtime.currentModel) disposeModel(runtime.currentModel);
      renderer.dispose();
      canvas.remove();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (active && !paused && runtime.frame === null) {
      const render = () => {
        runtime.frame = null;
        if (!activeRef.current || pausedRef.current) return;
        runtime.renderer.render(runtime.scene, runtime.camera);
        runtime.frame = window.requestAnimationFrame(render);
      };
      runtime.frame = window.requestAnimationFrame(render);
    }
  }, [active, paused]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !active) return;

    let cancelled = false;
    setLoadState('loading');
    setLoadPercent(0);
    setLoadError('');
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(
      modelUrl,
      (gltf) => {
        if (cancelled) {
          disposeModel(gltf.scene);
          return;
        }

        gltf.scene.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) return;
          child.castShadow = false;
          child.receiveShadow = false;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.forEach((material) => {
            material.depthWrite = true;
            material.needsUpdate = true;
          });
        });

        const bounds = new THREE.Box3().setFromObject(gltf.scene);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        gltf.scene.position.sub(center);
        const model = new THREE.Group();
        model.add(gltf.scene);
        model.scale.setScalar(2.3 / Math.max(size.x, size.y, size.z, 0.001));

        const previous = runtime.currentModel;
        runtime.currentModel = model;
        runtime.scene.add(model);
        rotationRef.current = 0;
        if (viewerRef.current) viewerRef.current.dataset.rotation = '0';

        if (motionDisabled) {
          model.position.set(0, 0, 0);
          if (previous) {
            runtime.scene.remove(previous);
            disposeModel(previous);
          }
        } else if (previous) {
          model.position.set(0, -2.5, 0);
          model.rotation.y = -Math.PI * 2;
          switchTimelineRef.current?.kill();
          switchTimelineRef.current = gsap.timeline({
            defaults: { duration: 0.82, ease: 'power3.inOut' },
            onComplete: () => {
              runtime.scene.remove(previous);
              disposeModel(previous);
            }
          })
            .to(previous.position, { y: 2.5 }, 0)
            .to(previous.rotation, { y: previous.rotation.y + Math.PI * 2 }, 0)
            .to(model.position, { y: 0 }, 0.18)
            .to(model.rotation, { y: 0 }, 0.18);
        } else {
          const progress = entryRef.current;
          model.position.set((1 - progress) * 1.3, (1 - progress) * -2.35, 0);
          model.rotation.y = (1 - progress) * -Math.PI * 2;
        }

        setLoadPercent(100);
        setLoadState('ready');
      },
      (event) => {
        if (event.total > 0) {
          setLoadPercent(Math.min(99, Math.round(event.loaded / event.total * 100)));
        }
      },
      (error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
          setLoadState('error');
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [active, modelUrl, motionDisabled]);

  useEffect(() => {
    const model = runtimeRef.current?.currentModel;
    if (!model || motionDisabled) return;
    model.position.x = (1 - entryProgress) * 1.3;
    model.position.y = (1 - entryProgress) * -2.35;
    model.rotation.y = rotationRef.current + (1 - entryProgress) * -Math.PI * 2;
  }, [entryProgress, motionDisabled]);

  return (
    <div
      ref={viewerRef}
      className={styles.viewer}
      data-load-state={loadState}
      data-rotation="0"
      role="img"
      aria-label={`${platformName} 3D 模型，可水平拖动旋转`}
      onWheelCapture={(event) => {
        // WebGL 画布会截获部分浏览器的滚轮输入，统一转交给全局章节控制器。
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(new WheelEvent('wheel', {
          bubbles: false,
          cancelable: true,
          deltaMode: event.deltaMode,
          deltaX: event.deltaX,
          deltaY: event.deltaY
        }));
      }}
    >
      {loadState !== 'ready' ? (
        <p className={styles.status} role="status">
          {loadState === 'error'
            ? `模型加载失败：${loadError || '未知错误'}`
            : `正在载入模型 ${loadPercent}%`}
        </p>
      ) : null}
    </div>
  );
}
