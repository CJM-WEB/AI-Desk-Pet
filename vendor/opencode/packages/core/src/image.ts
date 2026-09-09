export * as Image from "./image"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { FileSystem } from "./filesystem"

export class ResizerUnavailableError extends Schema.TaggedErrorClass<ResizerUnavailableError>()(
  "Image.ResizerUnavailableError",
  {},
) {}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("Image.DecodeError", {
  resource: Schema.String,
}) {
  override get message() {
    return `Image could not be decoded: ${this.resource}`
  }
}

export class SizeError extends Schema.TaggedErrorClass<SizeError>()("Image.SizeError", {
  resource: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  bytes: Schema.Number,
  maxWidth: Schema.Number,
  maxHeight: Schema.Number,
  maxBytes: Schema.Number,
}) {
  override get message() {
    return `Image ${this.resource} is ${this.width}x${this.height} with base64 size ${this.bytes}, exceeding configured limits ${this.maxWidth}x${this.maxHeight}/${this.maxBytes} bytes`
  }
}

export interface Interface {
  readonly normalize: (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
  ) => Effect.Effect<
    FileSystem.Content & { readonly encoding: "base64" },
    ResizerUnavailableError | DecodeError | SizeError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

// 有限嵌入不分发 Bun 专用 Photon；保持原 read 的 ResizerUnavailableError 回退协议。
const layer = Layer.succeed(Service, Service.of({
  normalize: () => Effect.fail(new ResizerUnavailableError()),
}))

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer))

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node] })
