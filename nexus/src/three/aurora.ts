import * as THREE from "three";

/** Bake the fine curtain strands once; animation only bends their UV coordinates. */
export function paintAurora(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  // Bake against black so faint strands do not carry noisy unpremultiplied RGB values.
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const bands = [
    { phase: 0.4, y: 0.57, color: "251,113,133", strength: 0.28 },
    { phase: 2.6, y: 0.61, color: "251,146,60", strength: 0.20 },
    { phase: 4.1, y: 0.52, color: "253,224,71", strength: 0.12 },
  ];
  for (const band of bands) {
    for (let x = 0; x < width; x += 3) {
      const u = x / width;
      const edge = height * (band.y + Math.sin(u * Math.PI * 4 + band.phase) * 0.065
        + Math.sin(u * Math.PI * 10 - band.phase) * 0.018);
      const reach = height * (0.07 + 0.025 * Math.sin(u * Math.PI * 6 + band.phase));
      const envelope = Math.pow(Math.sin(u * Math.PI), 0.8);
      const strands = 0.70 + 0.15 * Math.sin(u * 217 + band.phase) + 0.08 * Math.sin(u * 487);
      const alpha = band.strength * envelope * strands;
      const glow = ctx.createLinearGradient(0, edge - reach, 0, edge + height * 0.06);
      glow.addColorStop(0, `rgba(${band.color},0)`);
      glow.addColorStop(0.55, `rgba(${band.color},${alpha * 0.28})`);
      glow.addColorStop(0.75, `rgba(${band.color},${alpha})`);
      glow.addColorStop(1, `rgba(${band.color},0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(x, edge - reach, 3, reach + height * 0.06);
    }
  }
  ctx.restore();
}

/** Replaces the existing sky material, adding no geometry or draw calls. */
export function createAuroraMaterial(texture: THREE.Texture, dark: boolean, background: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uMap: { value: texture },
      uTime: { value: 0 },
      uDark: { value: dark ? 1 : 0 },
      uBackground: { value: new THREE.Color(background) },
    },
    vertexShader: `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D uMap;
      uniform float uTime;
      uniform float uDark;
      uniform vec3 uBackground;
      varying vec2 vUv;
      void main() {
        vec2 uv = vUv;
        uv.x += 0.012 * sin(uTime * 0.035 + uv.y * 9.0);
        uv.y += 0.010 * sin(uv.x * 13.0 + uTime * 0.055);
        vec4 curtain = texture2D(uMap, uv);
        float breathe = 0.90 + 0.10 * sin(uTime * 0.09 + vUv.x * 5.0);
        vec3 glow = curtain.rgb * breathe * mix(0.15, 0.85, uDark);
        gl_FragColor = vec4(uBackground + glow, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}
