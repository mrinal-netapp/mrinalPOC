import React from "react"

import { Breadcrumb } from "./breadcrumb"
import "./breadcrumb.demo.scss"

export default function BreadcrumbDemo(): React.JSX.Element {
  return (
    <div className="breadcrumb-demo">
      <h2 className="breadcrumb-demo__title">Breadcrumb</h2>

      {/* single item */}
      <p className="breadcrumb-demo__subtitle">Single item (page only)</p>
      <div className="breadcrumb-demo__section">
        <div className="breadcrumb-demo__row">
          <Breadcrumb items={[{ label: "Dashboard", href: "/dashboard" }]} />
        </div>
      </div>

      {/* two items */}
      <p className="breadcrumb-demo__subtitle">Two items (link + page)</p>
      <div className="breadcrumb-demo__section">
        <div className="breadcrumb-demo__row">
          <Breadcrumb
            items={[
              { label: "Home", href: "/" },
              { label: "Settings", href: "/settings" },
            ]}
          />
        </div>
      </div>

      {/* three items */}
      <p className="breadcrumb-demo__subtitle">Three items (link + link + page)</p>
      <div className="breadcrumb-demo__section">
        <div className="breadcrumb-demo__row">
          <Breadcrumb
            items={[
              { label: "Home", href: "/" },
              { label: "Documentation", href: "/docs" },
              { label: "API Reference", href: "/docs/api" },
            ]}
          />
        </div>
      </div>

      {/* four+ items (with ellipsis) */}
      <p className="breadcrumb-demo__subtitle">Four+ items (link + ellipsis + page)</p>
      <div className="breadcrumb-demo__section">
        <div className="breadcrumb-demo__row">
          <Breadcrumb
            items={[
              { label: "Home", href: "/" },
              { label: "Products", href: "/products" },
              { label: "Category", href: "/products/category" },
              { label: "Subcategory", href: "/products/category/sub" },
              { label: "Item Details", href: "/products/category/sub/item" },
            ]}
          />
        </div>
      </div>
    </div>
  )
}
