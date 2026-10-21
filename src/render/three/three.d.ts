/**
 * Объявления типов для `three` — ровно те, которыми пользуется этот проект.
 *
 * Зачем они здесь. `three@0.186.1` типов НЕ несёт (в пакете нет ни одного
 * `.d.ts`), а `@types/three` — новая зависимость, и ставить её запрещено
 * (ничего не устанавливать). Без объявлений `import * as THREE from 'three'`
 * роняет `tsc --noEmit` на TS7016 в строгом режиме.
 *
 * Почему не пустой `declare module 'three'`. Он сделал бы весь three.js
 * одним большим `any`, и тогда `build3D(...): THREE.Group` перестал бы быть
 * типом вовсе — опечатка в имени метода доехала бы до устройства. Здесь же
 * объявлено только то, что код действительно трогает: список короткий, его
 * видно глазом, и каждая строка проверяется прогоном (поддельный тип,
 * которого в three нет, упал бы в тесте, а не прошёл молча).
 *
 * Чего эти объявления НЕ значат: они не описание three.js и не его
 * документация. Это договор ОДНОГО проекта с ОДНОЙ версией библиотеки,
 * закреплённой точно (`0.186.1`, спека). Понадобится новое имя — его сюда
 * дописывают вместе с его использованием, а не «на будущее».
 */
declare module 'three' {
  export class Vector3 {
    constructor(x?: number, y?: number, z?: number)
    x: number
    y: number
    z: number
    set(x: number, y: number, z: number): this
    copy(v: Vector3): this
  }

  export class Euler {
    constructor(x?: number, y?: number, z?: number, order?: string)
    x: number
    y: number
    z: number
    set(x: number, y: number, z: number, order?: string): this
    setFromQuaternion(q: Quaternion, order?: string): this
  }

  export class Quaternion {
    constructor(x?: number, y?: number, z?: number, w?: number)
    setFromEuler(e: Euler): this
  }

  export class Color {
    constructor(color?: number | string)
    r: number
    g: number
    b: number
    set(color: number | string | Color): this
    copy(c: Color): this
    getHexString(): string
  }

  export class Matrix4 {
    constructor()
    compose(position: Vector3, quaternion: Quaternion, scale: Vector3): this
    decompose(position: Vector3, quaternion: Quaternion, scale: Vector3): this
    multiplyMatrices(a: Matrix4, b: Matrix4): this
    copy(m: Matrix4): this
    clone(): Matrix4
    identity(): this
  }

  export class Object3D {
    name: string
    readonly type: string
    readonly children: Object3D[]
    readonly position: Vector3
    readonly rotation: Euler
    readonly scale: Vector3
    readonly matrix: Matrix4
    readonly matrixWorld: Matrix4
    parent: Object3D | null
    add(...objects: Object3D[]): this
    remove(...objects: Object3D[]): this
    clear(): this
    traverse(callback: (object: Object3D) => void): void
    updateMatrixWorld(force?: boolean): void
  }

  export class Group extends Object3D {}
  export class Scene extends Object3D {
    fog: Fog | null
    background: Color | null
  }

  export class Fog {
    constructor(color: number | string, near?: number, far?: number)
    color: Color
    near: number
    far: number
  }

  export class BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number, normalized?: boolean)
    readonly count: number
    /**
     * Номер версии буфера: по нему `WebGLRenderer` решает, перезаливать ли
     * его на видеокарту. Единственное, что здесь можно ПРОЧИТАТЬ: сам
     * `needsUpdate` в three объявлен только сеттером и при чтении отдаёт
     * `undefined`.
     */
    readonly version: number
    needsUpdate: boolean
  }

  export class BufferGeometry {
    constructor()
    readonly attributes: Record<string, BufferAttribute | undefined>
    setAttribute(name: string, attribute: BufferAttribute): this
    dispose(): void
  }

  export class Material {
    readonly isMaterial: true
    name: string
    transparent: boolean
    opacity: number
    fog: boolean
    needsUpdate: boolean
    dispose(): void
  }

  export class MeshBasicMaterial extends Material {
    constructor(parameters?: {
      color?: number | string | Color
      map?: unknown
      fog?: boolean
      toneMapped?: boolean
      side?: number
    })
    readonly isMeshBasicMaterial: true
    readonly color: Color
    map: unknown
    toneMapped: boolean
    side: number
  }

  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material | Material[])
    readonly isMesh: true
    geometry: BufferGeometry
    material: Material | Material[]
  }

  export class InstancedMesh extends Mesh {
    constructor(geometry: BufferGeometry, material: Material, count: number)
    readonly isInstancedMesh: true
    count: number
    readonly instanceMatrix: BufferAttribute
    instanceColor: BufferAttribute | null
    setMatrixAt(index: number, matrix: Matrix4): void
    getMatrixAt(index: number, matrix: Matrix4): void
    setColorAt(index: number, color: Color): void
    getColorAt(index: number, color: Color): void
    dispose(): void
  }

  export class PerspectiveCamera extends Object3D {
    constructor(fov?: number, aspect?: number, near?: number, far?: number)
    fov: number
    aspect: number
    near: number
    far: number
    updateProjectionMatrix(): void
  }

  export class WebGLRenderer {
    constructor(parameters?: {
      canvas?: unknown
      antialias?: boolean
      alpha?: boolean
      powerPreference?: string
    })
    setPixelRatio(value: number): void
    setSize(width: number, height: number, updateStyle?: boolean): void
    render(scene: Object3D, camera: Object3D): void
    dispose(): void
    readonly info: { render: { calls: number; triangles: number } }
  }

  export const DoubleSide: number
  export const BackSide: number
}
