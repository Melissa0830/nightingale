import { authenticate } from "@/lib/auth/jwt";
import { assertPatientAccess } from "@/lib/auth/clinic-scope";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);
    const { id } = await params;

    const patient = await prisma.patient.findUnique({
      where: { id },
      select: {
        id: true,
        clinicId: true,
        displayName: true,
        createdAt: true,
      },
    });
    if (!patient) {
      throw new ApiError(404, "Patient not found");
    }

    // resource 存在但跨 clinic -> 403
    // Patient 存取他人 patient record -> 403
    assertPatientAccess(user, patient);

    return Response.json({
      id: patient.id,
      clinicId: patient.clinicId,
      displayName: patient.displayName,
      createdAt: patient.createdAt,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
