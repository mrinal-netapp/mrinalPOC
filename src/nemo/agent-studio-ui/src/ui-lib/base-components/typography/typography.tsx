import type { ElementType, HTMLAttributes, ReactElement, ReactNode } from 'react';
import type { VariantProps } from 'class-variance-authority';
import { cn } from "@/ui-lib/lib/utils"
import { typographyVariants } from './typography.variants';
import './typography.scss';

interface TypographyProps extends HTMLAttributes<HTMLElement>,
  VariantProps<typeof typographyVariants> {
  children: ReactNode;
  isCenter?: boolean;
  isEllipsis?: boolean;
  isNowrap?: boolean;
  Component?: ElementType;
  /** Color of the text, must be a valid css color definition */
  color?: string;
  isDisabled?: boolean;
  /** Only effective when Component="label" */
  htmlFor?: string;
}

const Typography = (props: TypographyProps): ReactElement => {
  const {
    children,
    isCenter,
    isEllipsis,
    isNowrap,
    className,
    Component = 'div',
    color,
    isDisabled,
    fontSize = 'fs16',
    boldness = 'regular',
    fontFamily = 'regular',
    ...rest
  } = props;

  const _className = cn(
    typographyVariants({ fontSize, boldness, fontFamily }),
    "typography-base--display",
    className,
    isDisabled && 'typography--disabled',
    isCenter && 'typography--center',
    isEllipsis && 'typography--ellipsis',
    isNowrap && 'typography--nowrap',
  );

  return (
    <Component className={cn("typography-base", _className)} {...rest} style={{ ...rest.style, ...(color ? { color } : {}) }}>
      {children}
    </Component>
  );
};

export { Typography };
export type { TypographyProps };
