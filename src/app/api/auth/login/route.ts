import { prisma } from "@/lib/prisma";
import { signToken } from "@/lib/auth/jwt";
import { ApiError, toErrorResponse } from "@/lib/errors";

export async function POST(request: Request): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ApiError(400, "Invalid request body");
    }

    const body = raw as { email?: unknown };
    if (typeof body.email !== "string" || body.email.trim().length === 0) {
      throw new ApiError(400, "email is required");
    }
    const email = body.email.trim();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Generic — does not reveal whether the email is registered.
      throw new ApiError(401, "Invalid credentials");
    }

    if (user.role === "Patient") {
      if (!user.patientId) {
        // Data integrity: Patient-role User is missing patientId. Treat as invalid.
        throw new ApiError(401, "Invalid credentials");
      }
      return Response.json({
        token: signToken({
          id: user.id,
          clinicId: user.clinicId,
          role: user.role,
          patientId: user.patientId,
        }),
      });
    }

    return Response.json({
      token: signToken({
        id: user.id,
        clinicId: user.clinicId,
        role: user.role,
      }),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
