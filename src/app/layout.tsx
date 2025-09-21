import "./globals.css";

export const metadata = {
  title: "Ações PAI – Gestor de Portfólios",
  description: "Controle de ações com preço médio, valorização, gatilhos e dividendos."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}