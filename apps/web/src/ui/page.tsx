import type { ReactElement, ReactNode } from "react";
import { motion, useIsPresent } from "motion/react";
import { KineticTitle } from "../fx/kinetic-title.js";

export function Page({
  index,
  eyebrow,
  title,
  lede,
  actions,
  children,
}: {
  index: string;
  eyebrow: string;
  title: string;
  lede?: string | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
}): ReactElement {
  return <>
    <header className="page-header">
      <p className="eyebrow" data-index={index}>{eyebrow}</p>
      <h1 className="display"><KineticTitle text={title} /></h1>
      {lede && <p className="muted">{lede}</p>}
      {actions && <div className="page-actions">{actions}</div>}
    </header>
    <div className="page-body">{children}</div>
  </>;
}

export function RouteTransition({ children }: { children: ReactNode }): ReactElement {
  const isPresent = useIsPresent();
  return (
    <motion.div
      initial={{ opacity: 0, y: 14, clipPath: "inset(0 0 100% 0)" }}
      animate={{ opacity: 1, y: 0, clipPath: "inset(0 0 0% 0)" }}
      exit={{ opacity: 0, y: -10, clipPath: "inset(0 0 100% 0)" }}
      transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
      style={{ height: "100%" }}
      inert={isPresent ? undefined : true}
      aria-hidden={isPresent ? undefined : true}
    >
      {children}
    </motion.div>
  );
}
