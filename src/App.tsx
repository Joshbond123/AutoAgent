import { SupabaseProvider } from "./contexts/SupabaseContext";
import Dashboard from "./components/Dashboard";

function App() {
  return (
    <SupabaseProvider>
      <Dashboard />
    </SupabaseProvider>
  );
}

export default App;
