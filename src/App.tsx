import { HashRouter } from 'react-router-dom'
import {
  isSupabaseConfigured,
  missingSupabaseVariables,
} from './lib/supabase'
import './App.css'

function StartupPage() {
  return (
    <main className="startup">
      <section className="card" aria-labelledby="page-title">
        <p className="eyebrow">WORKSPACE</p>
        <h1 id="page-title">AnotherNotion</h1>
        <div
          className={`status ${isSupabaseConfigured ? 'status--ready' : 'status--error'}`}
          role={isSupabaseConfigured ? 'status' : 'alert'}
        >
          <span className="status__dot" aria-hidden="true" />
          <div>
            <strong>
              {isSupabaseConfigured
                ? 'Supabase 配置已就绪'
                : 'Supabase 配置缺失'}
            </strong>
            {!isSupabaseConfigured && (
              <p>
                请在 <code>.env.local</code> 中配置：
                {missingSupabaseVariables.join('、')}
              </p>
            )}
          </div>
        </div>
      </section>
    </main>
  )
}

function App() {
  return (
    <HashRouter>
      <StartupPage />
    </HashRouter>
  )
}

export default App
