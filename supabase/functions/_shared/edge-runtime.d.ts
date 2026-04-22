declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

declare module "https://deno.land/std@0.204.0/http/server.ts" {
  export function serve(
    handler: (request: Request) => Response | Promise<Response>,
  ): void;
}

declare module "https://esm.sh/@supabase/supabase-js@2" {
  type SupabaseUser = {
    id: string;
    email?: string | null;
  };

  type SupabaseAuthResult = {
    data: { user: SupabaseUser | null };
    error: { message?: string } | null;
  };

  export function createClient(
    url: string,
    key: string,
    options?: unknown,
  ): {
    auth: {
      getUser(token?: string): Promise<SupabaseAuthResult>;
      admin?: {
        deleteUser(userId: string): Promise<{ error: { message?: string } | null }>;
      };
    };
  };
}
