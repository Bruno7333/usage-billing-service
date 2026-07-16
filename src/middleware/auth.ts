import type { Request, Response, NextFunction } from "express";
import { prisma } from "../db";

export async function requireAuth(req: Request, res: Response, next: NextFunction){
    const header = req.header("authorization");
    const apiKey = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
 
    if (!apiKey){
        return res.status(401).json({ error: "Missing API key" });
    }


    const tenant = await prisma.tenant.findUnique({
        where: { apiKey },
        include: { plan: true },
    });

    if (!tenant){
        return res.status(401).json({ error: "Invalid API key" });
    }

    res.locals.tenant = tenant;
    next();
}