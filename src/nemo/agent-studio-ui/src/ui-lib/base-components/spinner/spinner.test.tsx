import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders } from "@test/render"

import { Spinner } from "./spinner"

describe("Spinner", () => {
  // -- 3.2 Default rendering
  it("[tag:spinner][tag:rendering] should render with role status, default aria-label Loading, and spinner-size-inline class when no props are given", () => {
    renderWithProviders(<Spinner />)

    const spinner = screen.getByRole("status")
    expect(spinner).toHaveAttribute("aria-label", "Loading")
    expect(spinner).toHaveClass("spinner-size-inline")
  })

  // -- 3.3 Size: inline
  it("[tag:spinner][tag:size][tag:inline] should apply spinner-size-inline class when size is inline", () => {
    renderWithProviders(<Spinner size="inline" />)

    expect(screen.getByRole("status")).toHaveClass("spinner-size-inline")
  })

  // -- 3.4 Size: fullScreen
  it("[tag:spinner][tag:size][tag:fullScreen] should apply spinner-size-full-screen class when size is fullScreen", () => {
    renderWithProviders(<Spinner size="fullScreen" />)

    expect(screen.getByRole("status")).toHaveClass("spinner-size-full-screen")
  })

  // -- 3.5 Size: fitContent
  it("[tag:spinner][tag:size][tag:fitContent] should apply spinner-size-fit-content class when size is fitContent", () => {
    renderWithProviders(<Spinner size="fitContent" />)

    expect(screen.getByRole("status")).toHaveClass("spinner-size-fit-content")
  })

  // -- 3.6 Default SVG
  it("[tag:spinner][tag:icon] should render an svg with a circle element inside spinner__svg when icon is omitted", () => {
    const { container } = renderWithProviders(<Spinner />)

    const svg = container.querySelector("svg.spinner__svg")
    expect(svg).toBeInTheDocument()

    const circle = svg?.querySelector("circle")
    expect(circle).toBeInTheDocument()
  })

  // -- 3.7 Custom icon
  it("[tag:spinner][tag:icon] should render the custom icon inside spinner__svg and not render the default svg when icon is provided", () => {
    const { container } = renderWithProviders(
      <Spinner icon={<span data-testid="custom-icon" />} />,
    )

    expect(screen.getByTestId("custom-icon")).toBeInTheDocument()

    const svgWrapper = container.querySelector(".spinner__svg")
    expect(svgWrapper).toBeInTheDocument()
    expect(svgWrapper?.querySelector("svg")).not.toBeInTheDocument()
  })

  // -- 3.8 Disabled state
  it("[tag:spinner][tag:disabled] should apply spinner--disabled class when isDisabled is true", () => {
    renderWithProviders(<Spinner isDisabled={true} />)

    expect(screen.getByRole("status")).toHaveClass("spinner--disabled")
  })

  // -- 3.9 Grey state
  it("[tag:spinner][tag:grey] should apply spinner--grey class when isGrey is true", () => {
    renderWithProviders(<Spinner isGrey={true} />)

    expect(screen.getByRole("status")).toHaveClass("spinner--grey")
  })

  // -- 3.10 Title only
  it("[tag:spinner][tag:details] should render title in spinner__details, set aria-label to the title, and apply spinner--with-details when only title is provided", () => {
    const { container } = renderWithProviders(<Spinner title="Loading data" />)

    const spinner = screen.getByRole("status")
    expect(spinner).toHaveAttribute("aria-label", "Loading data")
    expect(spinner).toHaveClass("spinner--with-details")

    const details = container.querySelector(".spinner__details")
    expect(details).toBeInTheDocument()
    expect(screen.getByText("Loading data")).toBeInTheDocument()
  })

  // -- 3.11 Description only
  it("[tag:spinner][tag:details] should render description in spinner__details and apply spinner--with-details when only description is provided", () => {
    const { container } = renderWithProviders(<Spinner description="Please wait..." />)

    const spinner = screen.getByRole("status")
    expect(spinner).toHaveClass("spinner--with-details")

    const details = container.querySelector(".spinner__details")
    expect(details).toBeInTheDocument()
    expect(screen.getByText("Please wait...")).toBeInTheDocument()
  })

  // -- 3.12 Title and description
  it("[tag:spinner][tag:details] should render both title and description in spinner__details when both are provided", () => {
    const { container } = renderWithProviders(
      <Spinner title="Loading data" description="Please wait..." />,
    )

    const details = container.querySelector(".spinner__details")
    expect(details).toBeInTheDocument()
    expect(screen.getByText("Loading data")).toBeInTheDocument()
    expect(screen.getByText("Please wait...")).toBeInTheDocument()
  })

  // -- 3.13 No details
  it("[tag:spinner][tag:details] should not render spinner__details and not apply spinner--with-details when title and description are omitted", () => {
    const { container } = renderWithProviders(<Spinner />)

    expect(container.querySelector(".spinner__details")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).not.toHaveClass("spinner--with-details")
  })

  // -- 3.14 FullScreen with details
  it("[tag:spinner][tag:fullScreen][tag:details] should render spinner__card wrapper around svg and details when size is fullScreen and details are provided", () => {
    const { container } = renderWithProviders(
      <Spinner size="fullScreen" title="Loading" description="Almost there" />,
    )

    const card = container.querySelector(".spinner__card")
    expect(card).toBeInTheDocument()
    expect(card?.querySelector(".spinner__svg")).toBeInTheDocument()
    expect(card?.querySelector(".spinner__details")).toBeInTheDocument()
  })

  // -- 3.15 FullScreen without details
  it("[tag:spinner][tag:fullScreen] should not render spinner__card when size is fullScreen but no details are provided", () => {
    const { container } = renderWithProviders(<Spinner size="fullScreen" />)

    expect(container.querySelector(".spinner__card")).not.toBeInTheDocument()
  })

  // -- 3.16 className forwarding
  it("[tag:spinner][tag:className] should append a custom className to the spinner's class list", () => {
    renderWithProviders(<Spinner className="my-custom-class" />)

    expect(screen.getByRole("status")).toHaveClass("my-custom-class")
  })
})
