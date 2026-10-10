/* The React Three Fiber scene for a globe (companies or people: the controller's
   GlobeContent says which). Builds every three.js object once (imperatively,
   disposed on unmount), hands them to the GlobeController, and forwards pointer
   events on the badges. All per-frame work happens in controller.frame(). Only one
   globe's scene is mounted at a time; on unmount the controller keeps the camera so
   the globe can come back as it was. */
import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { registerScene } from "../../debug/registry";
import { watchContext } from "../../three/contextWatch";
import { onBadgeBaked } from "../../three/logoTexture";
import type { BadgeSprite, GlobeController } from "./controller";
import type { GlobeNodeBase } from "./globeLayout";
import { FatLines, SurfaceDots, applyGlassPalette, createGlassMaterial } from "./materials";
import { watchGlobePalette } from "./palette";
import { atmosphereTexture, coreTexture, glowTexture } from "./sceneTextures";

interface SceneObjects {
  glass: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  atmosphere: THREE.Sprite;
  core: THREE.Sprite;
  selGlow: THREE.Sprite;
  sprites: BadgeSprite[];
  spokes: FatLines;
  cross: FatLines;
  documented: FatLines;
  fits: FatLines;
  dots: SurfaceDots;
  textures: THREE.Texture[];
}

/**
 * A sprite material that can fade its logo toward paper (uFade) instead of
 * turning see-through, so dimmed badges stay solid and nothing behind them
 * shows through. All badges share one compiled program.
 */
function badgeMaterial(map: THREE.Texture, fadeColor: { value: THREE.Color }): THREE.SpriteMaterial {
  const m = new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false });
  const fade = { value: 0 };
  m.userData.fade = fade;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFade = fade;
    shader.uniforms.uFadeColor = fadeColor;
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "uniform float uFade;\nuniform vec3 uFadeColor;\nvoid main() {")
      .replace("#include <map_fragment>", "#include <map_fragment>\n\tdiffuseColor.rgb = mix( diffuseColor.rgb, uFadeColor, uFade );");
  };
  m.customProgramCacheKey = () => "mm-badge-fade";
  return m;
}

function buildObjects<N extends GlobeNodeBase>(ctl: GlobeController<N>, reduced: boolean): SceneObjects {
  const R = ctl.R;
  const P = ctl.palette;

  const glass = new THREE.Mesh(new THREE.SphereGeometry(R, 128, 96), createGlassMaterial(ctl.content.glass));
  glass.renderOrder = 1;
  glass.raycast = () => {};

  const atmoTex = atmosphereTexture();
  const atmosphere = new THREE.Sprite(new THREE.SpriteMaterial({ map: atmoTex, color: P.atmosphere, transparent: true, depthWrite: false, depthTest: false, opacity: P.dark ? 0.22 : 0.08 }));
  atmosphere.renderOrder = -1;
  atmosphere.raycast = () => {};

  const coreTex = coreTexture({ ink: P.ink, teal: P.teal, paper: P.paper });
  // The publisher remains a camera-facing hub stamp over the solid planet.
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: coreTex, transparent: true, depthWrite: false, depthTest: false, opacity: 0.94 }));
  core.scale.setScalar(R * 0.62);
  core.renderOrder = 2.5;
  core.raycast = () => {};

  const glowTex = glowTexture();
  const selGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, opacity: 0.7 }));
  selGlow.renderOrder = 4;
  selGlow.visible = false;
  selGlow.raycast = () => {};

  const fadeColor = { value: new THREE.Color(P.paper) };
  const sprites = ctl.layout.nodes.map((nd, i) => {
    const badge = ctl.content.badge(nd);
    const s = new THREE.Sprite(badgeMaterial(badge.texture, fadeColor)) as BadgeSprite;
    s.position.copy(ctl.nodeLocal[i]).multiplyScalar(ctl.badgeR);
    s.scale.set(ctl.badgeW, ctl.badgeH, 1);
    s.userData.idx = i;
    s.renderOrder = 3;
    return s;
  });

  const flow = reduced ? 0 : 1;
  const spokes = new FatLines({ width: 1.35, backAlpha: 0, rimFade: 0.6, radius: R });
  const cross = new FatLines({ width: 1.2, backAlpha: 0, rimFade: 1, radius: R });
  const documented = new FatLines({ width: 2.6, pulse: 1, flow: 16 * flow, backAlpha: 0, radius: R });
  const fits = new FatLines({ width: 2.3, dash: 2.6, dashRatio: 0.56, flow: 7 * flow, backAlpha: 0, radius: R });
  const dots = new SurfaceDots(R);
  spokes.mesh.renderOrder = 2;
  cross.mesh.renderOrder = 2.1;
  documented.mesh.renderOrder = 2.2;
  fits.mesh.renderOrder = 2.3;
  dots.points.renderOrder = 1.5;

  return { glass, atmosphere, core, selGlow, sprites, spokes, cross, documented, fits, dots, textures: [atmoTex, coreTex, glowTex] };
}

function disposeObjects(o: SceneObjects): void {
  o.glass.geometry.dispose();
  o.glass.material.dispose();
  for (const s of [o.atmosphere, o.core, o.selGlow]) s.material.dispose();
  // Each renderer hangs a 'dispose' listener on every texture and geometry it uploads, and the
  // listener keeps that renderer (its context, its canvas and through it the whole detached view)
  // alive until the resource is disposed. So dispose the badge textures too: they stay in
  // logoTexture.ts's cache with their pixels kept as bytes (the walk view uses the unlabeled
  // variants, not these), and the next mount uploads them again. The same goes for the one
  // geometry three.js shares between every Sprite; a later upload by any renderer is just as safe.
  for (const s of o.sprites) {
    s.material.map?.dispose();
    s.material.dispose();
  }
  o.atmosphere.geometry.dispose();
  for (const b of [o.spokes, o.cross, o.documented, o.fits]) b.dispose();
  o.dots.dispose();
  for (const t of o.textures) t.dispose();
}

export default function GlobeScene<N extends GlobeNodeBase>({ ctl, reduced, intro, onContextGiveUp }: { ctl: GlobeController<N>; reduced: boolean; intro: boolean; onContextGiveUp: () => void }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const setDpr = useThree((s) => s.setDpr);
  const invalidate = useThree((s) => s.invalidate);
  const globeRef = useRef<THREE.Group>(null);
  const controlsRef = useRef<OrbitControlsImpl>(null);
  // Built once per controller. `reduced` only sets the initial flow speed; frame() also stops time under reduced motion.
  const o = useMemo(() => buildObjects(ctl, reduced), [ctl]);

  useLayoutEffect(() => {
    ctl.globe = globeRef.current;
    ctl.sprites = o.sprites;
    ctl.glass = o.glass.material;
    ctl.atmosphere = o.atmosphere;
    ctl.core = o.core;
    ctl.selGlow = o.selGlow;
    ctl.batches = { spokes: o.spokes, cross: o.cross, documented: o.documented, fits: o.fits, dots: o.dots };
    ctl.buildStaticLines();
    ctl.init(camera, size.width, size.height, intro);
    return () => {
      ctl.detach(camera);
      // The controller outlives the scene (the other globe may be in view for a while): let go of
      // the disposed objects so they can be collected.
      ctl.globe = null;
      ctl.batches = null;
      ctl.sprites = [];
      ctl.glass = null;
      ctl.atmosphere = null;
      ctl.core = null;
      ctl.selGlow = null;
    };
  }, [ctl, o]);

  useEffect(() => () => disposeObjects(o), [o]);

  useEffect(() => watchGlobePalette((palette) => {
    const repaintCore = palette.ink !== ctl.palette.ink || palette.teal !== ctl.palette.teal || palette.paper !== ctl.palette.paper;
    Object.assign(ctl.palette, palette);
    applyGlassPalette(o.glass.material, palette);
    if (ctl.content.roster === "people") o.glass.material.uniforms.uColor.value[0].set(palette.personGlass);
    o.atmosphere.material.color.set(palette.atmosphere);
    o.atmosphere.material.opacity = palette.dark ? 0.22 : 0.08;
    if (repaintCore) {
      const previous = o.core.material.map;
      const texture = coreTexture({ ink: palette.ink, teal: palette.teal, paper: palette.paper });
      o.core.material.map = texture;
      o.textures[1] = texture;
      previous?.dispose();
    }
    ctl.buildStaticLines();
    invalidate();
  }), [ctl, o, invalidate]);

  useEffect(() => {
    // Retain native resolution, then spend up to eight million pixels on retina detail.
    const desired = Math.max(1, Math.min(window.devicePixelRatio || 1, 2.5, Math.sqrt(8_000_000 / Math.max(1, size.width * size.height))));
    if (Math.abs(dpr - desired) > 0.001) setDpr(desired);
  }, [setDpr, size.width, size.height, dpr]);

  // ?debug: show the live scene to the diagnostic probe (does nothing otherwise).
  useEffect(() => registerScene({ view: "mindmap", renderer: gl, scene, camera, badges: o.sprites, controller: ctl }), [gl, scene, camera, o, ctl]);

  // Under reduced motion the canvas renders on demand (frameloop="demand"). The controller asks
  // for frames on input; these wake it for changes that come from outside the scene: a badge
  // repainted once its logo or the web font loads, and the detail sheet's height (--sheet-h on
  // the root element), which frame() reads to keep the globe above the sheet.
  useEffect(() => {
    const wake = () => invalidate();
    ctl.invalidate = wake;
    const offBake = onBadgeBaked(wake);
    const sheet = new MutationObserver(wake);
    sheet.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    wake();
    return () => {
      ctl.invalidate = () => {};
      offBake();
      sheet.disconnect();
    };
  }, [ctl, invalidate]);

  // A lost WebGL context: three.js rebuilds everything when the browser restores it, and this
  // canvas may render on demand, so ask for a frame then; if it is never restored, start over.
  useEffect(() => watchContext(gl.domElement, { restored: () => invalidate(), giveUp: onContextGiveUp }), [gl, invalidate, onContextGiveUp]);

  useEffect(() => {
    ctl.resize(size.width, size.height);
    ctl.setResolution(size.width, size.height, dpr);
    ctl.remeasure();
  }, [ctl, size.width, size.height, dpr]);

  useEffect(() => {
    const flow = reduced ? 0 : 1;
    o.documented.material.uniforms.uFlow.value = 16 * flow;
    o.fits.material.uniforms.uFlow.value = 7 * flow;
  }, [o, reduced]);

  // Pointer presence over the canvas (rotation pauses while it is over the globe).
  useEffect(() => {
    const el = gl.domElement;
    ctl.attachCanvas(el);
    const enter = () => {
      ctl.pointerInside = true;
      ctl.invalidate();
    };
    const leave = () => {
      ctl.pointerInside = false;
      ctl.setHovered(-1);
      ctl.invalidate();
    };
    // Whether the pointer is over the globe (which holds rotation) is worked out in frame().
    const move = () => {
      if (ctl.playing) ctl.invalidate();
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointermove", move);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointermove", move);
      ctl.attachCanvas(null);
    };
  }, [ctl, gl]);

  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    ctl.controls = c;
    c.minDistance = ctl.R + 14;
    c.maxDistance = ctl.homeDist * 1.7;
    return () => {
      ctl.controls = null;
    };
  }, [ctl]);

  useFrame((state, dt) => ctl.frame(state.camera as THREE.PerspectiveCamera, state.pointer, dt));

  const idxOf = (e: ThreeEvent<PointerEvent | MouseEvent>): number => {
    const i = (e.object.userData as { idx?: number }).idx;
    return typeof i === "number" ? i : -1;
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const i = idxOf(e);
    if (i < 0 || ctl.vis[i] < 0.5) return;
    e.stopPropagation();
    ctl.setHovered(i);
  };
  const onOut = (e: ThreeEvent<PointerEvent>) => {
    if (idxOf(e) === ctl.hovered) ctl.setHovered(-1);
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    const i = idxOf(e);
    if (i < 0 || ctl.vis[i] < 0.5 || e.delta > 6) return;
    e.stopPropagation();
    ctl.content.pick(ctl.layout.nodes[i]);
  };

  return (
    <>
      <primitive object={o.atmosphere} />
      <group ref={globeRef}>
        <primitive object={o.core} />
        <primitive object={o.glass} />
        <primitive object={o.dots.points} />
        <primitive object={o.spokes.mesh} />
        <primitive object={o.cross.mesh} />
        <primitive object={o.documented.mesh} />
        <primitive object={o.fits.mesh} />
        <primitive object={o.selGlow} />
        <group onPointerMove={onMove} onPointerOut={onOut} onClick={onClick}>
          {o.sprites.map((s) => (
            <primitive key={s.id} object={s} />
          ))}
        </group>
      </group>
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enablePan={false}
        enableDamping={!reduced}
        dampingFactor={0.075}
        rotateSpeed={0.5}
        zoomSpeed={0.75}
        onStart={() => ctl.interactionStart()}
        onEnd={() => ctl.interactionEnd()}
      />
    </>
  );
}
