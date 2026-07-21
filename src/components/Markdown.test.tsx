import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

describe('安全 Markdown', () => {
  afterEach(cleanup)
  it('支持 GFM 表格、任务清单和代码块', () => {
    render(<Markdown>{'|列|值|\n|-|-|\n|a|b|\n\n- [x] 完成\n\n```ts\nconst ok = true\n```'}</Markdown>)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(screen.getByText('const ok = true')).toBeInTheDocument()
  })
  it('忽略原始 HTML 并为外链增加安全属性', () => {
    const { container } = render(<Markdown>{'<script>alert(1)</script>\n\n[官网](https://example.com)'}</Markdown>)
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByRole('link', { name: '官网' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('link', { name: '官网' })).toHaveAttribute('target', '_blank')
  })
  it('不会渲染可执行的危险链接', () => {
    render(<Markdown>{'[危险链接](javascript:alert(1))'}</Markdown>)
    expect(screen.getByText('危险链接')).not.toHaveAttribute('href', expect.stringMatching(/^javascript:/i))
  })
})
