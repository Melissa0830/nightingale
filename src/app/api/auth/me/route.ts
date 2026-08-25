import { authenticate } from "@/lib/auth/jwt";
import { toErrorResponse } from "@/lib/errors";

export async function GET(request: Request): Promise<Response> {
  try {
    const user = authenticate(request);
    return Response.json(user);
  } catch (error) {
    return toErrorResponse(error);
  }
}
