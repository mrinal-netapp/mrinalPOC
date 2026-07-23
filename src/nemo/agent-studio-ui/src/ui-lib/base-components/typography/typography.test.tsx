import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@test/render'
import { Typography } from './typography'

describe('Typography', () => {
  // 3.1 Default rendering
  it('[tag:typography] should render a div with base and default variant classes when no variant props are given', () => {
    // Setup + Execute
    renderWithProviders(<Typography>Hello</Typography>)

    // Validate
    const el = screen.getByText('Hello')
    expect(el.tagName).toBe('DIV')
    expect(el).toHaveClass('typography-base')
    expect(el).toHaveClass('typography-base--display')
    expect(el).toHaveClass('typography--16')
    expect(el).toHaveClass('typography--regular')
    expect(el).toHaveTextContent('Hello')
  })

  // 3.2 fontSize variants
  it('[tag:typography][tag:variant][tag:fontSize] should apply typography--12 when fontSize="fs12"', () => {
    renderWithProviders(<Typography fontSize="fs12">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--12')
  })

  it('[tag:typography][tag:variant][tag:fontSize] should apply typography--13 when fontSize="fs13"', () => {
    renderWithProviders(<Typography fontSize="fs13">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--13')
  })

  it('[tag:typography][tag:variant][tag:fontSize] should apply typography--14 when fontSize="fs14"', () => {
    renderWithProviders(<Typography fontSize="fs14">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--14')
  })

  it('[tag:typography][tag:variant][tag:fontSize] should apply typography--16 when fontSize="fs16"', () => {
    renderWithProviders(<Typography fontSize="fs16">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--16')
  })

  it('[tag:typography][tag:variant][tag:fontSize] should apply typography--20 when fontSize="fs20"', () => {
    renderWithProviders(<Typography fontSize="fs20">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--20')
  })

  it('[tag:typography][tag:variant][tag:fontSize] should apply typography--24 when fontSize="fs24"', () => {
    renderWithProviders(<Typography fontSize="fs24">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--24')
  })

  it('[tag:typography][tag:variant][tag:fontSize] should apply typography--32 when fontSize="fs32"', () => {
    renderWithProviders(<Typography fontSize="fs32">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--32')
  })

  it('[tag:typography][tag:variant][tag:fontSize] should apply typography--40 when fontSize="fs40"', () => {
    renderWithProviders(<Typography fontSize="fs40">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--40')
  })

  // 3.3 boldness variants
  it('[tag:typography][tag:variant][tag:boldness] should apply typography--regular when boldness="regular"', () => {
    renderWithProviders(<Typography boldness="regular">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--regular')
  })

  it('[tag:typography][tag:variant][tag:boldness] should apply typography--semibold when boldness="semibold"', () => {
    renderWithProviders(<Typography boldness="semibold">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--semibold')
  })

  // 3.4 fontFamily variants
  it('[tag:typography][tag:variant][tag:fontFamily] should not apply monospace class when fontFamily="regular"', () => {
    renderWithProviders(<Typography fontFamily="regular">text</Typography>)
    expect(screen.getByText('text')).not.toHaveClass('typography--monospace')
  })

  it('[tag:typography][tag:variant][tag:fontFamily] should apply typography--monospace when fontFamily="monospace"', () => {
    renderWithProviders(<Typography fontFamily="monospace">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--monospace')
  })

  // 3.5 Boolean modifiers — presence
  it('[tag:typography] should apply typography--center when isCenter=true', () => {
    renderWithProviders(<Typography isCenter>text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--center')
  })

  it('[tag:typography] should not apply typography--center when isCenter=false', () => {
    renderWithProviders(<Typography isCenter={false}>text</Typography>)
    expect(screen.getByText('text')).not.toHaveClass('typography--center')
  })

  it('[tag:typography] should apply typography--ellipsis when isEllipsis=true', () => {
    renderWithProviders(<Typography isEllipsis>text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--ellipsis')
  })

  it('[tag:typography] should not apply typography--ellipsis when isEllipsis=false', () => {
    renderWithProviders(<Typography isEllipsis={false}>text</Typography>)
    expect(screen.getByText('text')).not.toHaveClass('typography--ellipsis')
  })

  it('[tag:typography] should apply typography--nowrap when isNowrap=true', () => {
    renderWithProviders(<Typography isNowrap>text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--nowrap')
  })

  it('[tag:typography] should not apply typography--nowrap when isNowrap=false', () => {
    renderWithProviders(<Typography isNowrap={false}>text</Typography>)
    expect(screen.getByText('text')).not.toHaveClass('typography--nowrap')
  })

  it('[tag:typography][tag:disabled] should apply typography--disabled when isDisabled=true', () => {
    renderWithProviders(<Typography isDisabled>text</Typography>)
    expect(screen.getByText('text')).toHaveClass('typography--disabled')
  })

  it('[tag:typography][tag:disabled] should not apply typography--disabled when isDisabled=false', () => {
    renderWithProviders(<Typography isDisabled={false}>text</Typography>)
    expect(screen.getByText('text')).not.toHaveClass('typography--disabled')
  })

  // 3.6 Custom Component
  it('[tag:typography] should render as a span when Component="span"', () => {
    renderWithProviders(<Typography Component="span">text</Typography>)
    expect(screen.getByText('text').tagName).toBe('SPAN')
  })

  it('[tag:typography] should render as an h1 when Component="h1"', () => {
    renderWithProviders(<Typography Component="h1">text</Typography>)
    expect(screen.getByText('text').tagName).toBe('H1')
  })

  it('[tag:typography] should render as a p when Component="p"', () => {
    renderWithProviders(<Typography Component="p">text</Typography>)
    expect(screen.getByText('text').tagName).toBe('P')
  })

  // 3.7 Custom color
  it('[tag:typography] should apply inline color style when color prop is provided', () => {
    renderWithProviders(<Typography color="red">text</Typography>)
    // Check the inline style property directly — toHaveStyle uses getComputedStyle which normalises named colours to rgb()
    expect(screen.getByText('text').style.color).toBe('red')
  })

  // 3.8 className forwarding
  it('[tag:typography] should include custom className in the element class list', () => {
    renderWithProviders(<Typography className="my-custom-class">text</Typography>)
    expect(screen.getByText('text')).toHaveClass('my-custom-class')
  })

  // 3.9 Prop forwarding
  it('[tag:typography] should forward data-testid to the underlying element', () => {
    renderWithProviders(<Typography data-testid="typo-el">text</Typography>)
    expect(screen.getByTestId('typo-el')).toBeInTheDocument()
  })

  it('[tag:typography] should forward id attribute to the underlying element', () => {
    renderWithProviders(<Typography id="typo-id">text</Typography>)
    expect(screen.getByText('text')).toHaveAttribute('id', 'typo-id')
  })
})
