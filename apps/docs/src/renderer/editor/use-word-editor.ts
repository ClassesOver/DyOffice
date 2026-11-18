import { useEditor, type UseEditorOptions } from '@tiptap/react'

export function useWordEditor(options: UseEditorOptions) {
  // 等组件提交后再创建，避免浏览器让出执行权时清理计时器销毁首屏实例。
  return useEditor({ ...options, immediatelyRender: false })
}
