import type { ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Button } from "@/ui-lib/base-components/button/button"
import { cardFooterVariants } from "./card.variants"
import type { CardFooterProps } from "./card.types"
import "./card.scss"

function CardFooter({
  variant = "default",
  hasSeparator,
  actions,
  cancelButton,
  alignment,
  children,
  className,
}: CardFooterProps): ReactElement {
  const rootClass = cn(
    cardFooterVariants({ alignment, variant }),
    cancelButton && "card-footer--has-cancel",
    hasSeparator && "card-footer--has-separator",
    className,
  )

  if (children != null) {
    return (
      <div data-slot="card-footer" className={rootClass}>
        {children}
      </div>
    )
  }

  // Fill variant: actions expand 50/50 with a vertical separator between them.
  // Forces flat button variant to match the fill background styling.
  if (variant === "fill") {
    const fillActions = actions?.slice(0, 2) ?? []
    return (
      <div data-slot="card-footer" className={rootClass}>
        {fillActions.map((action, idx) => (
          <div key={idx === 0 ? "primary" : "secondary"} className="card-footer__fill-action">
            {idx > 0 && <span className="card-footer__fill-separator" />}
            <Button {...action} variant="flat" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div data-slot="card-footer" className={rootClass}>
      {cancelButton && (
        <div className="card-footer__cancel">
          <Button {...cancelButton} />
        </div>
      )}
      {actions && actions.length > 0 && (
        <div className="card-footer__actions">
          {actions.slice(0, 2).map((action, idx) => (
            <Button key={idx} {...action} />
          ))}
        </div>
      )}
    </div>
  )
}

export { CardFooter }
export type { CardFooterProps }
