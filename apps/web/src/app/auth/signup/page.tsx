import { redirect } from "next/navigation";

// Public self-signup is intentionally disabled: Sparks onboards customers (install a
// meter, provision the account, invite the user). Anyone hitting /auth/signup is sent
// to the sign-in page. Account creation happens operator-side via admin.createCustomer.
export default function SignupPage() {
  redirect("/auth/login");
}
