// 识图历史的文件存储。
//
// 为什么不用 DSH 的 storageDomain：
//   storageDomain 每次 put 都会 ctx.emit("domain/changed")，前端收到就重渲染
//   消息列表，图片组件被销毁重建、重新 createObjectURL、浏览器重新解码——
//   用户看到的就是「转写完成后整张图闪一下」。实测：跳过写历史后 2 秒内
//   图片 DOM 变化次数从 1 降到 0。所以改成本模块直接落盘，不触发任何事件。
//
// 代价：原子写与坏记录隔离要自己实现（storageDomain 原本自带）。
//   - 原子写：先写 .tmp 再 rename，rename 在同一文件系统上是原子的，
//     因此不会出现「读到半个 JSON」。
//   - 坏记录：读取时单条解析失败只跳过该条，不影响其他记录。

import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 落盘文件的版本号。与 storageDomain 时代的格式保持一致，便于混读。 */
export const STORE_VERSION = 1;

/** 只在文件名里接受这种键，挡掉路径穿越。 */
const KEY_PATTERN = /^[0-9]+-[a-z0-9]+$/;

/**
 * 把 key 映射成文件名。
 *
 * @param {string} key - 记录键。
 * @returns {string} 文件名。
 */
function fileNameOf(key) {
  return `${key}.json`;
}

/**
 * 从一个文件里解出记录内容。
 *
 * @param {string} path - 文件绝对路径。
 * @returns {Promise<object|undefined>} 记录对象；文件损坏或格式不符时为 undefined。
 */
async function readRecordFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    const record = parsed?.record ?? parsed;
    if (!record || typeof record !== "object") return undefined;
    if (typeof record.time !== "number") return undefined;
    return record;
  } catch {
    // 坏文件、半截文件、权限问题一律跳过：历史记录是旁路，不能因为一条坏数据影响整页。
    return undefined;
  }
}

/**
 * 列出目录里所有合法的记录文件名。
 *
 * @param {string} dir - 目录。
 * @returns {Promise<string[]>} 文件名数组；目录不存在时为空数组。
 */
async function listRecordFiles(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (!name.endsWith(".json")) return false;
    return KEY_PATTERN.test(name.slice(0, -".json".length));
  });
}

/**
 * 创建一个基于目录的文件存储，接口与 storageDomain 的 table 一致。
 *
 * @param {object} options - 选项。
 * @param {string} options.dir - 主目录（写入这里）。
 * @param {string[]} [options.readDirs] - 额外只读目录（用于兼容旧数据）。
 * @param {(error: Error) => void} [options.onWarn] - 写失败时的回调。
 * @returns {object} store。
 */
export function createFileStore({ dir, readDirs = [], onWarn } = {}) {
  const allDirs = () => [dir, ...readDirs];

  const ensureDir = async () => {
    await mkdir(dir, { recursive: true });
  };

  return {
    /** 主目录，供调用方记录或诊断。 */
    dir,

    /**
     * 原子写入一条记录。
     *
     * @param {string} key - 记录键。
     * @param {object} value - 记录内容。
     * @returns {Promise<void>}
     */
    async put(key, value) {
      if (!KEY_PATTERN.test(String(key))) throw new Error(`非法记录键：${key}`);
      await ensureDir();
      const target = join(dir, fileNameOf(key));
      const temp = `${target}.tmp`;
      await writeFile(temp, JSON.stringify({ version: STORE_VERSION, record: value }), "utf8");
      await rename(temp, target);
    },

    /**
     * 同步遍历所有记录，接口与 Map.entries() 一致。
     *
     * storageDomain 的 entries() 是同步的内存镜像；文件实现做不到同步，
     * 所以这里返回 Promise。调用方一律 await，两种实现都成立。
     *
     * @returns {Promise<Array<[string, object]>>} 键值对数组。
     */
    async entries() {
      const rows = [];
      const seen = new Set();
      for (const scanDir of allDirs()) {
        const names = await listRecordFiles(scanDir);
        for (const name of names) {
          const key = name.slice(0, -".json".length);
          if (seen.has(key)) continue;
          seen.add(key);
          const record = await readRecordFile(join(scanDir, name));
          if (record) rows.push([key, record]);
        }
      }
      return rows;
    },

    /**
     * 读取单条记录。
     *
     * @param {string} key - 记录键。
     * @returns {Promise<object|undefined>} 记录内容。
     */
    async get(key) {
      if (!KEY_PATTERN.test(String(key))) return undefined;
      for (const scanDir of allDirs()) {
        const record = await readRecordFile(join(scanDir, fileNameOf(key)));
        if (record) return record;
      }
      return undefined;
    },

    /**
     * 删除单条记录（不区分目录）。
     *
     * @param {string} key - 记录键。
     * @returns {Promise<boolean>} 是否删掉了文件。
     */
    async delete(key) {
      if (!KEY_PATTERN.test(String(key))) return false;
      let removed = false;
      for (const scanDir of allDirs()) {
        try {
          await unlink(join(scanDir, fileNameOf(key)));
          removed = true;
        } catch {
          // 不存在就是没删到，继续下一个目录。
        }
      }
      return removed;
    },

    /**
     * 批量删除。
     *
     * @param {Iterable<string>} keys - 记录键集合。
     * @returns {Promise<number>} 实际删除的条数。
     */
    async deleteMany(keys) {
      const list = [...keys];
      let count = 0;
      for (const key of list) {
        try {
          if (await this.delete(key)) count += 1;
        } catch (error) {
          onWarn?.(error);
        }
      }
      return count;
    },
  };
}

/**
 * 新数据目录：插件自己的地盘，不再经过 storages/ 下的 storageDomain 区域。
 *
 * @returns {string} 绝对路径。
 */
export function defaultHistoryDir() {
  return join(homedir(), ".dsh", "auto-vision-bridge", "history");
}

/**
 * 旧 storageDomain 时代的目录，只读兼容（格式相同，可直接混读）。
 *
 * @returns {string} 绝对路径。
 */
export function legacyHistoryDir() {
  return join(homedir(), ".dsh", "storages", "auto_vision_bridge", "events");
}
