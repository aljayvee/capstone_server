import { NextFunction, Request, Response } from "express";

type AsyncRouteHandler<Req extends Request = Request> = (
  req: Req,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

// Forwards rejected promises from async Express handlers to next(err), so the
// centralized errorHandler middleware (middleware/errorHandler.ts) can catch them.
export function asyncHandler<Req extends Request = Request>(fn: AsyncRouteHandler<Req>) {
  return (req: Req, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
