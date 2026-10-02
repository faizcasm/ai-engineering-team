import { z } from "zod";

/* =====================================================
   MCP SERVERS
===================================================== */

export const mcpTransportSchema = z.enum([
  "stdio",
  "sse",
  "http",
]);

export const createMcpServerSchema = z
  .object({
    name: z
      .string()
      .min(1, "Server name is required")
      .max(60, "Server name is too long")
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
        "Server name may contain letters, numbers, dashes and underscores"
      ),

    transport: mcpTransportSchema,

    command: z
      .string()
      .min(1)
      .max(300)
      .optional(),

    args: z
      .array(z.string().max(300))
      .max(50)
      .optional(),

    url: z
      .string()
      .url("url must be a valid URL")
      .max(500)
      .optional(),

    env: z
      .record(
        z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name"),

        z.string().max(2000)
      )
      .optional(),

    enabled: z.boolean().optional(),
  })

  .refine(
    (data) =>
      data.transport !== "stdio" || Boolean(data.command),
    {
      message: "command is required for the stdio transport",
      path: ["command"],
    }
  )

  .refine(
    (data) =>
      data.transport === "stdio" || Boolean(data.url),
    {
      message: "url is required for the sse and http transports",
      path: ["url"],
    }
  )

  .refine(
    (data) => data.transport !== "stdio" || !data.url,
    {
      message: "url is not valid for the stdio transport",
      path: ["url"],
    }
  );

export type CreateMcpServerInput = z.infer<
  typeof createMcpServerSchema
>;

/* =====================================================
   PARAMS
===================================================== */

export const mcpIdParamSchema = z
  .string()
  .min(1, "Server id is required")
  .max(80, "Server id is too long")
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    "Invalid server id"
  );
