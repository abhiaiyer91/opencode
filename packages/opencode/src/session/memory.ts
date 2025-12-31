import path from "path"
import { Global } from "@/global"
import { lazy } from "@/util/lazy"

export namespace MastraMemory {
  const instance = lazy(async () => {
    const { Memory } = await import("@mastra/memory")
    const { LibSQLStore } = await import("@mastra/libsql")

    const storage = new LibSQLStore({
      id: "opencode",
      url: "file:" + path.join(Global.Path.data, "mastra.db"),
    })

    return new Memory({ storage })
  })

  export function get() {
    return instance()
  }
}
