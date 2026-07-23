import { Typography } from './typography';
import './typography.demo.scss';

const FONT_SIZES = ['fs12', 'fs13', 'fs14', 'fs16', 'fs20', 'fs24', 'fs32', 'fs40'] as const;
const BOLDNESS = ['regular', 'semibold'] as const;

export default function TypographyDemo() {
  return (
    <div className="typography-demo">
      <h1 className="typography-demo__title">Typography Showcase</h1>

      {/* Font Size & Weight Combinations */}
      <section className="typography-demo__section">
        <h2 className="typography-demo__section-title">All Variants</h2>
        <div className="typography-demo__grid">
          {BOLDNESS.map((boldness) =>
            FONT_SIZES.map((fontSize) => (
              <div key={`${boldness}-${fontSize}`} className="typography-demo__cell">
                <Typography
                  fontSize={fontSize}
                  boldness={boldness}
                >
                  {boldness} {fontSize}
                </Typography>
                <span className="typography-demo__cell-label">
                  {boldness} {fontSize}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Text Properties */}
      <section className="typography-demo__section">
        <h2 className="typography-demo__section-title">Text Properties</h2>

        <div className="typography-demo__properties">
          <div className="typography-demo__property">
            <h3>Centered Text</h3>
            <Typography fontSize="fs16" isCenter>
              This text is centered
            </Typography>
          </div>

          <div className="typography-demo__property">
            <h3>Ellipsis (text overflow)</h3>
            <div className="typography-demo__ellipsis-container">
              <Typography fontSize="fs16" isEllipsis>
                This is a very long text that should be truncated with ellipsis when it exceeds the container width
              </Typography>
            </div>
          </div>

          <div className="typography-demo__property">
            <h3>No Wrap</h3>
            <Typography fontSize="fs16" isNowrap>
              This text will not wrap to the next line and will overflow
            </Typography>
          </div>

          <div className="typography-demo__property">
            <h3>Disabled State</h3>
            <Typography fontSize="fs16" isDisabled>
              This text appears disabled
            </Typography>
          </div>

          <div className="typography-demo__property">
            <h3>Custom Color</h3>
            <div className="typography-demo__color-group">
              <Typography fontSize="fs16" color="var(--notification-error)">
                Error Color
              </Typography>
              <Typography fontSize="fs16" color="var(--notification-success)">
                Success Color
              </Typography>
              <Typography fontSize="fs16" color="var(--notification-information)">
                Info Color
              </Typography>
            </div>
          </div>

          <div className="typography-demo__property">
            <h3>Custom Element</h3>
            <div className="typography-demo__element-group">
              <Typography Component="h1" fontSize="fs24" boldness="semibold">
                Heading 1
              </Typography>
              <Typography Component="h2" fontSize="fs20" boldness="semibold">
                Heading 2
              </Typography>
              <Typography Component="h3" fontSize="fs16" boldness="semibold">
                Heading 3
              </Typography>
              <Typography Component="p" fontSize="fs14">
                Paragraph
              </Typography>
              <Typography Component="span" fontSize="fs12">
                Small Span
              </Typography>
            </div>
          </div>
        </div>
      </section>

      {/* Combinations */}
      <section className="typography-demo__section">
        <h2 className="typography-demo__section-title">Combined Properties</h2>

        <div className="typography-demo__combinations">
          <div className="typography-demo__combo-item">
            <Typography
              fontSize="fs20"
              boldness="semibold"
              isCenter
              color="var(--text-primary)"
            >
              Centered, Bold, Custom Color
            </Typography>
          </div>

          <div className="typography-demo__combo-item">
            <div className="typography-demo__combo-container">
              <Typography
                fontSize="fs14"
                isEllipsis
                color="var(--text-secondary)"
              >
                Long text with ellipsis and custom color that should truncate when container is narrow
              </Typography>
            </div>
          </div>

          <div className="typography-demo__combo-item">
            <Typography
              fontSize="fs16"
              boldness="semibold"
              isDisabled
              isCenter
            >
              Disabled, Bold, Centered
            </Typography>
          </div>
        </div>
      </section>
    </div>
  );
}
