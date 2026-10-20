import { FormEvent, useState } from "react";
import { NotebookPenIcon } from "lucide-react";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function LoginScreen({
  error,
  onAuthenticate,
}: {
  error: string;
  onAuthenticate: (
    email: string,
    password: string,
    register: boolean,
  ) => Promise<void>;
}) {
  const [register, setRegister] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onAuthenticate(email, password, register);
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-secondary/40 px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-5">
      <div className="w-full max-w-md">
        <Card className="gap-0 shadow-sm ring-border">
          <CardHeader className="gap-1.5 p-5 pb-0 sm:p-7 sm:pb-0">
            <span
              aria-hidden="true"
              className="mb-1 grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground"
            >
              <NotebookPenIcon className="size-4" />
            </span>
            <CardTitle asChild>
              <h1 className="font-heading text-2xl font-semibold tracking-tight">
                {register ? "Создать аккаунт" : "Войти в ежедневник"}
              </h1>
            </CardTitle>
            <CardDescription>
              Задачи и встречи голосом или текстом.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 p-5 pt-5 sm:p-7 sm:pt-6">
            <form className="grid gap-4" onSubmit={submit}>
              <div className="grid gap-1.5">
                <Label htmlFor="auth-email">Email</Label>
                <Input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="auth-password">Пароль</Label>
                <Input
                  id="auth-password"
                  type="password"
                  autoComplete={register ? "new-password" : "current-password"}
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button className="w-full max-sm:h-11" size="lg">
                {register ? "Зарегистрироваться" : "Войти"}
              </Button>
            </form>
            <Button
              variant="link"
              className="mx-auto h-auto w-fit px-0 text-muted-foreground"
              onClick={() => setRegister(!register)}
            >
              {register ? "Уже есть аккаунт" : "Нет аккаунта? Создать"}
            </Button>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
