import { Router } from "express";
import { getDb } from "../../db/database.js";
import { requireAuth } from "../middleware/auth-middleware.js";
import {
  getNotificationsForUser,
  markAllRead,
  markOneRead,
  type NotifRole,
} from "../../notifications/notification-service.js";

export const notificationsRouter = Router();

// GET /api/notifications
notificationsRouter.get("/notifications", requireAuth, (req, res, next) => {
  try {
    const user = (req as Express.Request).sessionUser!;
    const result = getNotificationsForUser(
      getDb(), user.id, user.role as NotifRole,
    );
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/notifications/read-all
notificationsRouter.post("/notifications/read-all", requireAuth, (req, res, next) => {
  try {
    const user = (req as Express.Request).sessionUser!;
    markAllRead(getDb(), user.id, user.role as NotifRole);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/notifications/:id/read
notificationsRouter.post("/notifications/:id/read", requireAuth, (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const user = (req as Express.Request).sessionUser!;
    if (!id) return res.status(400).json({ error: "ID inválido." });
    markOneRead(getDb(), id, user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
