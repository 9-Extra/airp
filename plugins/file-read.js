// file-read: AIRP 预设的只读文件工具。
//
// 提供 `read_file` 工具：读取一个 UTF-8 文本文件，返回带行号的内容窗口，
// 供世界引擎叙事时引用玩家提供或工作区中的设定文档、笔记、角色卡等。
// 相对路径以会话工作目录为基准（与 airp-engine 的持久化目录同源），
// 也接受绝对路径；可用 offset/limit 分页读取大文件。
//
// 与 airp-engine 相同的本地插件模式：只消费宿主服务（tools），
// 不发布服务，因此无需 isolate realm；不 import 任何 @deepseek-ai 包
// （预设目录不在 harness 的 node_modules 解析链上），
// 工具定义按 ToolDefinition 形状手工构造。
//
// 只读边界：本工具绝不写文件。文件大小与单次输出均有上限，
// 防止误读超大文件拖垮会话。

import fs from 'node:fs/promises'
import path from 'node:path'

const name = 'file-read'
const inject = ['tools']

/** 默认/最大单次返回行数。 */
const READ_LIMIT = 2000
/** 单行最长保留字符数，超出截断。 */
const MAX_LINE_LENGTH = 2000
/** 单次调用输出字节上限（约 50KB）。 */
const MAX_BYTES = 50 * 1024
/** 超过该大小的文件拒绝读取，避免整读进内存。 */
const MAX_FILE_BYTES = 20 * 1024 * 1024

function parsePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} 必须是正整数`)
  return value
}

/**
 * 把全文切成带行号的窗口，强制行数与字节上限。
 * @param {string} text - 文件全文（UTF-8 解码后）。
 * @param {{ offset: number, limit: number }} request - 已校验的分页参数。
 * @returns {{ lines: Array<{number: number, text: string}>, totalLines: number, truncatedByBytes: boolean }}
 */
function buildWindow(text, request) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const totalLines = lines.length
  if (request.offset > totalLines && !(totalLines === 0 && request.offset === 1)) {
    throw new Error(`offset ${request.offset} 超出范围：该文件共 ${totalLines} 行`)
  }
  const out = []
  let outputBytes = 0
  let truncatedByBytes = false
  for (let i = request.offset - 1; i < totalLines && out.length < request.limit; i++) {
    const raw = lines[i]
    const textLine = raw.length > MAX_LINE_LENGTH
      ? `${raw.slice(0, MAX_LINE_LENGTH)}… (行已截断)`
      : raw
    const bytes = Buffer.byteLength(textLine, 'utf8') + (out.length > 0 ? 1 : 0)
    if (outputBytes + bytes > MAX_BYTES) {
      truncatedByBytes = true
      break
    }
    outputBytes += bytes
    out.push({ number: i + 1, text: textLine })
  }
  return { lines: out, totalLines, truncatedByBytes }
}

/** 把读取结果格式化成模型可见的文本块。 */
function formatReadOutput(displayPath, window, offset) {
  const endLine = window.lines.length > 0 ? window.lines[window.lines.length - 1].number : Math.max(0, offset - 1)
  let footer
  if (window.truncatedByBytes) {
    footer = `(输出已达字节上限，仅显示 ${offset}-${endLine} 行；用 offset=${endLine + 1} 继续读取。)`
  } else if (endLine < window.totalLines) {
    footer = `(共 ${window.totalLines} 行，当前显示 ${offset}-${endLine}；用 offset=${endLine + 1} 继续读取。)`
  } else {
    footer = `(文件结束 - 共 ${window.totalLines} 行)`
  }
  const body = window.lines.map((line) => `${line.number}: ${line.text}`).join('\n')
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${body ? `${body}\n\n${footer}` : footer}\n</content>`
}

function apply(ctx) {
  ctx.tools.register({
    name: 'read_file',
    description:
      '读取一个 UTF-8 文本文件并返回带行号的内容窗口。' +
      '用于读取玩家提供或工作区中的设定文档、笔记、角色卡、存档等文本文件；' +
      '相对路径以会话工作目录为基准，也支持绝对路径；' +
      '大文件可用 offset/limit 分页继续读取。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file_path'],
      properties: {
        file_path: {
          type: 'string',
          description: '要读取的文件路径（相对会话工作目录，或绝对路径）。',
        },
        offset: {
          type: 'number',
          description: '起始行号（1 起），默认 1。',
        },
        limit: {
          type: 'number',
          description: `最多返回行数，默认 ${READ_LIMIT}，最大 ${READ_LIMIT}。`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `读取文件 ${args?.file_path ?? ''}`,
      kind: 'other',
    }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('read_file 需要在会话上下文中执行')
      const filePath = String(args.file_path ?? '').trim()
      if (filePath.length === 0) throw new Error('file_path 不能为空')
      const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
      const limit = args.limit === undefined ? READ_LIMIT : parsePositiveInteger(args.limit, 'limit')
      if (limit > READ_LIMIT) throw new Error(`limit 不能超过 ${READ_LIMIT}`)

      const cwd = exec.agent.session.header?.cwd
      const absolute = path.resolve(cwd ?? process.cwd(), filePath)
      const info = await fs.stat(absolute).catch(() => undefined)
      if (info === undefined) throw new Error(`无法读取 "${absolute}"：文件不存在`)
      if (!info.isFile()) throw new Error(`无法读取 "${absolute}"：不是普通文件`)
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(`无法读取 "${absolute}"：文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB，请先拆分成较小的文件`)
      }

      const text = await fs.readFile(absolute, 'utf8')
      const window = buildWindow(text, { offset, limit })
      return { text: formatReadOutput(absolute, window, offset) }
    },
  })
}

export { name, inject, apply }
