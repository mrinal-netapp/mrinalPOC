import React from "react"

import { Button } from "@/ui-lib/base-components/button/button"
import { toast } from "./toast"
import "./toast.demo.scss"

export default function ToastDemo(): React.JSX.Element {
  return (
    <div className="toast-demo">
      <h2 className="toast-demo__title">Toast</h2>


      {/* default */}
      <p className="toast-demo__subtitle">Default toast</p>
      <div className="toast-demo__section">
        <div className="toast-demo__row">
          <Button
            label="Show toast"
            onClick={() => toast("This is a default toast")}
          />
        </div>
      </div>

      {/* success */}
      <p className="toast-demo__subtitle">Success</p>
      <div className="toast-demo__section">
        <div className="toast-demo__row">
          <Button
            label="Success"
            onClick={() => toast.success("Action completed successfully")}
          />
        </div>
      </div>

      {/* error */}
      <p className="toast-demo__subtitle">Error</p>
      <div className="toast-demo__section">
        <div className="toast-demo__row">
          <Button
            label="Error"
            onClick={() => toast.error("Something went wrong")}
          />
        </div>
      </div>

      {/* warning */}
      <p className="toast-demo__subtitle">Warning</p>
      <div className="toast-demo__section">
        <div className="toast-demo__row">
          <Button
            label="Warning"
            onClick={() => toast.warning("Proceed with caution")}
          />
        </div>
      </div>

      {/* info */}
      <p className="toast-demo__subtitle">Info</p>
      <div className="toast-demo__section">
        <div className="toast-demo__row">
          <Button
            label="Info"
            onClick={() => toast.info("Here is some information")}
          />
        </div>
      </div>

      {/* with description */}
      <p className="toast-demo__subtitle">With description</p>
      <div className="toast-demo__section">
        <div className="toast-demo__row">
          <Button
            label="Detailed toast"
            onClick={() =>
              toast("Event created", {
                description: "Monday, January 3rd at 6:00 PM",
              })
            }
          />
        </div>
      </div>

      {/* with action */}
      <p className="toast-demo__subtitle">With action button</p>
      <div className="toast-demo__section">
        <div className="toast-demo__row">
          <Button
            label="Action toast"
            onClick={() =>
              toast("File deleted", {
                action: {
                  label: "Undo",
                  onClick: () => toast("Restored!"),
                },
              })
            }
          />
        </div>
      </div>
    </div>
  )
}
