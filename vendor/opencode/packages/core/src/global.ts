import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"

const app = "opencode"
const data = path.join(xdgData ?? os.tmpdir(), app)
const cache = path.join(xdgCache ?? os.tmpdir(), app)
const config = path.join(xdgConfig ?? os.tmpdir(), app)
const state = path.join(xdgState ?? os.tmpdir(), app)
const tmp = path.join(os.tmpdir(), app)

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

// 嵌入宿主显式初始化任务数据目录；模块导入不创建目录或修改全局锁状态。
export async function initialize(directory: string): Promise<Interface> {
  const values = { home: directory, data: directory, cache: path.join(directory, "cache"),
    config: path.join(directory, "config"), state: path.join(directory, "state"),
    tmp: path.join(directory, "tmp"), bin: path.join(directory, "bin"),
    log: path.join(directory, "log"), repos: path.join(directory, "repos") };
  await Promise.all(Object.values(values).map(value => fs.mkdir(value, { recursive: true })));
  return values;
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.OPENCODE_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
