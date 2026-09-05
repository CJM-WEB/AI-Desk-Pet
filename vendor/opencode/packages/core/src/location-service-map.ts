import { Context, Effect, Layer, LayerMap } from "effect"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { Location } from "./location"
import type { Snapshot } from "./snapshot"

// 嵌入版本只绑定会话实际需要的位置和禁用快照，不引用完整产品服务图。
type LocationServices = Location.Service | Snapshot.Service
type LocationError = never

export class Service extends Context.Service<
  Service,
  LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>
>()("@opencode/example/LocationServiceMap") {
  static get(ref: Location.Ref) {
    return Layer.unwrap(Effect.map(Service, (locations) => locations.get(ref)))
  }
}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as LocationServiceMap from "./location-service-map"
