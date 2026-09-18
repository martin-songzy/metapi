import React, { type ReactNode } from 'react';

type TooltipProps = {
  content: string;
  children: ReactNode;
};

/**
 * 简单的悬停提示组件，使用浏览器原生 title 属性。
 * 对于更复杂的提示需求，可以扩展为自定义浮层。
 */
export function Tooltip({ content, children }: TooltipProps) {
  return (
    <span
      title={content}
      style={{ cursor: 'help', borderBottom: '1px dotted var(--color-text-muted)' }}
    >
      {children}
    </span>
  );
}

export function HelpIcon({ tooltip }: { tooltip: string }) {
  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        borderRadius: '50%',
        border: '1px solid var(--color-text-muted)',
        color: 'var(--color-text-muted)',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'help',
        marginLeft: 4,
        flexShrink: 0,
      }}
    >
      ?
    </span>
  );
}
