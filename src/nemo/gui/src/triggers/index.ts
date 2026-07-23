/**
 * Triggers module
 * Stub implementation for pipeline editor
 */

import React from 'react'
import type { BlockConfig, BlockIcon } from '@/blocks/types'

/**
 * Minimal icon component for stubs
 */
const StubIcon: BlockIcon = (props) => {
  return React.createElement(
    'svg',
    { ...props, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' },
    React.createElement('circle', { cx: '12', cy: '12', r: '10' })
  )
}

/**
 * Stub function that returns a minimal trigger config
 */
export function getTrigger(triggerId: string): BlockConfig {
  return {
    type: triggerId,
    name: triggerId,
    description: '',
    category: 'triggers',
    bgColor: '#6366f1',
    icon: StubIcon,
    subBlocks: [],
    tools: {
      access: [],
    },
    inputs: {},
    outputs: {},
  }
}

