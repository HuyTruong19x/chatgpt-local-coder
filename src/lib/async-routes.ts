import type { Request, Response, NextFunction } from "express";

// Existing installations can still have Express 4. Always forward rejected async
// handlers to the error middleware; Express 5 installations work identically.
export function guardAsyncRoutes<T extends object>(router: T): T {
  const target = router as any;
  const wrap = (value: any): any => {
    if (Array.isArray(value)) return value.map(wrap);
    if (typeof value !== "function" || value.length === 4) return value;
    return (req: Request, res: Response, next: NextFunction) => {
      try { Promise.resolve(value(req, res, next)).catch(next); } catch (error) { next(error); }
    };
  };
  for (const method of ["get", "post", "put", "patch", "delete", "use", "all"]) {
    const original = target[method];
    target[method] = function (...args: any[]) { return original.apply(this, args.map(wrap)); };
  }
  return router;
}
