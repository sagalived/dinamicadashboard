import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  // --- CONFIGURAÇÃO SIENGE ---
  const SIENGE_USERNAME = process.env.SIENGE_USERNAME || 'dinamicaempreendimentos-jrmorais';
  const SIENGE_PASSWORD = process.env.SIENGE_PASSWORD || '5jT2uxIW6YYAPL2epk9QUUvCEGM2eX9z';
  const SIENGE_INSTANCE = (process.env.SIENGE_INSTANCE || 'dinamicaempreendimentos').split('.')[0];

  // URL Padrão do Sienge para integrações de backend
  const SIENGE_BASE_URL = `https://api.sienge.com.br/${SIENGE_INSTANCE}`;

  // Autenticação Basic em Base64
  const siengeAuth = Buffer.from(`${SIENGE_USERNAME}:${SIENGE_PASSWORD}`).toString("base64");

  // Helper centralizado para chamadas à API
  const siengeAPI = axios.create({
    baseURL: SIENGE_BASE_URL,
    headers: {
      'Authorization': `Basic ${siengeAuth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    },
    timeout: 60000 // 60 segundos
  });

  // --- DESCOBERTA AUTOMÁTICA DE CAMINHO ---
  let detectedPrefix = '/public/api/v1'; // Padrão inicial

  async function discoverSiengePath() {
    const paths = ['/api/v1', '/public/api/v1'];
    const testEndpoints = ['/measure-units', '/obras', '/usuarios'];
    
    for (const p of paths) {
      for (const endpoint of testEndpoints) {
        try {
          const url = `${p}${endpoint}`;
          console.log(`[Sienge] Testando: ${SIENGE_BASE_URL}${url}`);
          const res = await siengeAPI.get(url, { params: { pageSize: 1 } });
          
          if (res.status === 200) {
            detectedPrefix = p;
            console.log(`✅ [Sienge] Sucesso total! Caminho: ${p} (via ${endpoint})`);
            return;
          }
        } catch (e: any) {
          const status = e.response?.status;
          // Se retornar 400 ou 401, o caminho existe mas o request ou auth tem detalhes
          // 400 (Bad Request) ou 403 (Forbidden) ou 401 (Unauthorized) indicam que o endpoint FOI ENCONTRADO
          if (status === 400 || status === 401 || status === 403 || status === 422) {
            detectedPrefix = p;
            console.log(`🟡 [Sienge] Caminho detectado (com ressalvas): ${p} (Status: ${status} em ${endpoint})`);
            return;
          }
          console.log(`❌ [Sienge] Falhou: ${p}${endpoint} (Erro: ${status || 'Conexão'})`);
        }
      }
    }
    console.warn(`⚠️ [Sienge] Não foi possível determinar o caminho exato, usando padrão: ${detectedPrefix}`);
  }

  // Executa a descoberta antes de liberar as rotas
  await discoverSiengePath();

  // --- PERSISTÊNCIA DE DADOS (CACHE) ---
  const DATA_DIR = path.join(process.cwd(), "data");
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR);
  }

  async function saveToFile(filename: string, data: any) {
    try {
      await fs.writeFile(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[Cache] Erro ao salvar ${filename}:`, e);
    }
  }

  async function readFromFile(filename: string) {
    const filePath = path.join(DATA_DIR, filename);
    if (existsSync(filePath)) {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        return JSON.parse(content);
      } catch (e) {
        console.error(`[Cache] Erro ao ler ${filename}:`, e);
        return null;
      }
    }
    return null;
  }

  async function fetchAll(endpoint: string, baseParams: any = {}) {
    let allResults: any[] = [];
    let offset = 0;
    const limit = 500;
    while (true) {
      try {
        const res = await siengeAPI.get(endpoint, { params: { ...baseParams, limit, offset } });
        const results = res.data.results || (Array.isArray(res.data) ? res.data : []);
        if (!Array.isArray(results) || results.length === 0) break;
        allResults = allResults.concat(results);
        offset += limit;
        if (results.length < limit) break; // Terminou de paginar
      } catch (err: any) {
        if (offset === 0) throw err; // Falha real se quebrar na primeira pág
        break;
      }
    }
    return { data: { results: allResults } };
  }

  let isSyncing = false;
  async function syncAllData() {
    if (isSyncing) {
      console.log("⏳ [Sync] Sincronização com Sienge já está em andamento. Cache mantido.");
      return;
    }
    isSyncing = true;
    console.log("🔄 [Sync] Iniciando sincronização completa com Sienge...");
    try {
      const startDateStr = "2019-01-01";
      const endDateStr = "2030-12-31";

      const [obrasRes, usuariosRes, credoresRes, pedidosRes, financeiroRes, receberRes, empresasRes, clientesRes] = await Promise.allSettled([
        siengeAPI.get(`${detectedPrefix}/obras`).catch(() => null),
        siengeAPI.get(`${detectedPrefix}/usuarios`).catch(() => null),
        siengeAPI.get(`${detectedPrefix}/credores`).catch(() => null),
        fetchAll(`${detectedPrefix}/pedidos-compra`),
        fetchAll(`${detectedPrefix}/titulos-pagar`, { dataEmissaoInicial: startDateStr, dataEmissaoFinal: endDateStr }),
        fetchAll(`${detectedPrefix}/titulos-receber`, { dataEmissaoInicial: startDateStr, dataEmissaoFinal: endDateStr }),
        siengeAPI.get(`${detectedPrefix}/companies`).catch(() => null),
        siengeAPI.get(`${detectedPrefix}/clientes`).catch(() => null)
      ]);

      let pedidos = pedidosRes.status === 'fulfilled' && pedidosRes.value ? (pedidosRes.value.data.results || pedidosRes.value.data) : [];
      let financeiro = financeiroRes.status === 'fulfilled' && financeiroRes.value ? (financeiroRes.value.data.results || financeiroRes.value.data) : [];
      let receber = receberRes.status === 'fulfilled' && receberRes.value ? (receberRes.value.data.results || receberRes.value.data) : [];
      
      let obras = obrasRes.status === 'fulfilled' && obrasRes.value?.data ? (obrasRes.value.data.results || obrasRes.value.data) : [];
      let usuarios = usuariosRes.status === 'fulfilled' && usuariosRes.value?.data ? (usuariosRes.value.data.results || usuariosRes.value.data) : [];
      let credores = credoresRes.status === 'fulfilled' && credoresRes.value?.data ? (credoresRes.value.data.results || credoresRes.value.data) : [];
      let empresas = empresasRes.status === 'fulfilled' && empresasRes.value?.data ? (empresasRes.value.data.results || empresasRes.value.data) : [];
      let clientes = clientesRes.status === 'fulfilled' && clientesRes.value?.data ? (clientesRes.value.data.results || clientesRes.value.data) : [];

      // Extrapolação de dados (Fallback p/ Endpoints bloqueados por código 400 da Sienge)
      if (obras.length === 0 && Array.isArray(pedidos)) {
        const map = new Map();
        pedidos.forEach((p: any) => { if (p.codigoVisivelObra || p.idObra) { const id = p.codigoVisivelObra || p.idObra; map.set(id, { id, nome: p.nomeObra || `Obra ${id}` }); } });
        obras = Array.from(map.values());
      }
      if (usuarios.length === 0 && Array.isArray(pedidos)) {
        const map = new Map();
        pedidos.forEach((p: any) => { if (p.codigoComprador || p.idComprador) { const id = p.codigoComprador || p.idComprador; map.set(id, { id: String(id), nome: p.nomeComprador || String(id) }); } });
        usuarios = Array.from(map.values());
      }
      if (credores.length === 0 && Array.isArray(pedidos)) {
        const map = new Map();
        pedidos.forEach((p: any) => { if (p.codigoFornecedor || p.idCredor) { const id = p.codigoFornecedor || p.idCredor; map.set(id, { id, nome: p.nomeFornecedor || `Credor ${id}` }); } });
        credores = Array.from(map.values());
      }

      await saveToFile("obras.json", obras);
      await saveToFile("usuarios.json", usuarios);
      await saveToFile("credores.json", credores);
      await saveToFile("empresas.json", empresas);
      await saveToFile("clientes.json", clientes);
      
      const itemsMap: Record<number, any> = {};
      try {
        const existingItems = await readFromFile("itens_pedidos.json") || {};
        Object.assign(itemsMap, existingItems);
      } catch (e) {}

      if (pedidosRes.status === 'fulfilled') {
        await saveToFile("pedidos.json", pedidosRes.value.data);
        
        // Sincronizar itens dos pedidos mais recentes no cache
        if (Array.isArray(pedidos)) {
          const topOrders = pedidos.slice(0, 50);
          for (const order of topOrders) {
            const id = order.id || order.numero;
            if (!itemsMap[id]) {
              try {
                const items = await siengeAPI.get(`/public/api/v1/purchase-orders/${id}/items`);
                itemsMap[id] = items.data.results || items.data || [];
              } catch (e) {}
            }
          }
          await saveToFile("itens_pedidos.json", itemsMap);
        }
      }
      if (financeiroRes.status === 'fulfilled') await saveToFile("financeiro.json", financeiroRes.value.data);
      if (receberRes.status === 'fulfilled') await saveToFile("receber.json", receberRes.value.data);

      // GERAR CSV CONSOLIDADO
      const csvHeaders = "Tipo,ID,Obra,Empresa,Fornecedor/Cliente/Descricao,Comprador,Data,Valor,Status,Condicao Pagamento/Prazos,Item/Insumo,Qtd,Un,Vlr Unit\n";
      const csvRows: string[] = [];

      pedidos.forEach((o: any) => {
        const idObra = o.idObra || o.codigoVisivelObra;
        const obraObj = obras.find((b: any) => String(b.id) === String(idObra));
        const obra = obraObj?.nome || idObra || "Não Informado";
        const empresa = empresas.find((e: any) => e.id === obraObj?.idCompany)?.name || "Dinamica";
        const idCredor = o.idCredor || o.codigoFornecedor;
        const supplier = credores.find((c: any) => String(c.id) === String(idCredor))?.nome || idCredor || "Não Informado";
        const idUser = o.idComprador || o.codigoComprador;
        const user = usuarios.find((u: any) => String(u.id) === String(idUser))?.nome || idUser || "Não Informado";
        const date = o.dataEmissao || o.data || "---";
        const valor = o.valorTotal || 0;
        const status = o.situacao || "N/A";
        const condicao = o.condicaoPagamentoDescricao || "N/A";
        const prazo = o.dataEntrega || o.prazoEntrega || "---";

        csvRows.push(`Pedido,${o.id || o.numero},"${obra}","${empresa}","${supplier}","${user}",${date},${valor},${status},"${condicao} / Prazo: ${prazo}","---","---","---","---"`);

        const items = itemsMap[o.id];
        if (Array.isArray(items)) {
          items.forEach((item: any) => {
            const desc = item.descricao || item.itemNome || "Item";
            const qtd = item.quantidade || 0;
            const un = item.unidadeMedidaSigla || "UN";
            const vlrU = item.valorUnitario || 0;
            const vlrT = item.valorTotal || 0;
            csvRows.push(`Item,${o.id},"${obra}","${empresa}","---","---",${date},${vlrT},"${status}","---","${desc}",${qtd},"${un}",${vlrU}`);
          });
        }
      });

      financeiro.forEach((f: any) => {
        const idObra = f.idObra || f.codigoVisivelObra;
        const obraObj = obras.find((b: any) => String(b.id) === String(idObra));
        const obra = obraObj?.nome || idObra || "Não Informado";
        const empresa = empresas.find((e: any) => e.id === obraObj?.idCompany)?.name || "Dinamica";
        const desc = f.descricao || f.historico || f.tipoDocumento || "Título a Pagar";
        csvRows.push(`A Pagar,${f.id || f.codigoTitulo},"${obra}","${empresa}","${desc}","---",${f.dataVencimento || f.dataEmissao || f.issueDate},${f.valor || f.valorSaldo},${f.situacao || "ABERTO"},"---","---","---","---","---"`);
      });

      receber.forEach((r: any) => {
        const obraObj = obras.find((b: any) => b.id === r.idObra);
        const obra = obraObj?.nome || r.idObra || "Não Informado";
        const empresa = empresas.find((e: any) => e.id === obraObj?.idCompany)?.name || "Dinamica";
        const desc = r.descricao || r.historico || "Título a Receber";
        csvRows.push(`A Receber,${r.id || r.numero || r.codigoTitulo},"${obra}","${empresa}","${desc}","---",${r.dataVencimento || r.dataEmissao},${r.valor || r.valorSaldo},${r.situacao || "ABERTO"},"---","---","---","---","---"`);
      });

      await saveToFile("consolidado.csv", "\ufeff" + csvHeaders + csvRows.join("\n"));
      console.log("✅ [Sync] Sincronização Sienge concluída! CSV atualizado.");
      return true;
    } catch (e) {
      console.error("❌ [Sync] Erro crítico na sincronização: ", e);
      return false;
    } finally {
      isSyncing = false;
    }
  }

  // Sincronização automática a cada 30 minutos
  setInterval(syncAllData, 30 * 60 * 1000);
  
  // Primeira sincronização ao iniciar
  syncAllData();

  // --- ROTAS DA API ---

  // Rota para forçar sincronização manual
  app.post("/api/sienge/sync", async (req, res) => {
    const success = await syncAllData();
    if (success) {
      res.json({ message: "Sincronização concluída com sucesso", timestamp: new Date() });
    } else {
      res.status(500).json({ error: "Falha na sincronização" });
    }
  });

  // Rota para baixar o CSV consolidado
  app.get("/api/sienge/download-csv", async (req, res) => {
    const filePath = path.join(DATA_DIR, "consolidado.csv");
    if (existsSync(filePath)) {
      res.download(filePath, "sienge_consolidado.csv");
    } else {
      res.status(404).json({ error: "Arquivo CSV ainda não gerado. Aguarde a sincronização." });
    }
  });

  // Rota de Teste de Conexão
  app.get("/api/sienge/test", async (req, res) => {
    const testEndpoints = ['/measure-units', '/obras', '/usuarios', '/credores'];
    let lastError: any = null;

    for (const endpoint of testEndpoints) {
      try {
        const response = await siengeAPI.get(`${detectedPrefix}${endpoint}`, { params: { pageSize: 1 } });
        return res.json({ 
          status: "Conectado!", 
          resource: endpoint,
          path: detectedPrefix,
          data: response.data 
        });
      } catch (error: any) {
        lastError = error;
        // Se não for 404, significa que o caminho existe mas deu outro erro (auth, params, etc)
        if (error.response?.status && error.response?.status !== 404) {
          return res.json({ 
            status: "Conectado (com erro de recurso)!", 
            resource: endpoint,
            path: detectedPrefix,
            error: error.response?.data || error.message
          });
        }
      }
    }

    console.error("Erro no teste de conexão final:", lastError?.response?.data || lastError?.message);
    res.status(lastError?.response?.status || 500).json({
      erro: "Falha na conexão com Sienge",
      detalhes: lastError?.response?.data || lastError?.message,
      pathTentado: detectedPrefix
    });
  });

  app.get("/api/sienge/itens-pedidos", async (req, res) => {
    try {
      const cached = await readFromFile("itens_pedidos.json");
      return res.json(cached || {});
    } catch (e) {
      res.status(500).json({ error: "Failed to read itens cache" });
    }
  });

  app.post("/api/sienge/fetch-items", async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids)) return res.json({});
      
      let itemsMap: Record<number, any> = await readFromFile("itens_pedidos.json") || {};
      let changed = false;

      for (const id of ids) {
        if (!itemsMap[id]) {
          try {
            const result = await siengeAPI.get(`/public/api/v1/purchase-orders/${id}/items`);
            itemsMap[id] = result.data?.results || result.data || [];
            changed = true;
          } catch (e) {}
        }
      }
      
      if (changed) {
        await saveToFile("itens_pedidos.json", itemsMap);
      }
      return res.json(itemsMap);
    } catch (error: any) {
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  app.get("/api/sienge/financeiro", async (req, res) => {
    try {
      const cached = await readFromFile("financeiro.json");
      if (cached && !req.query.force) return res.json(cached);
      
      const response = await siengeAPI.get(`${detectedPrefix}/titulos-pagar`, { params: req.query });
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/financeiro/receber", async (req, res) => {
    try {
      const cached = await readFromFile("receber.json");
      if (cached && !req.query.force) return res.json(cached);

      const response = await siengeAPI.get(`${detectedPrefix}/titulos-receber`, { params: req.query });
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/notas-entrada", async (req, res) => {
    try {
      const response = await siengeAPI.get(`${detectedPrefix}/notas-fiscais-entrada`, { params: req.query });
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/itens-nota/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const response = await siengeAPI.get(`${detectedPrefix}/notas-fiscais-entrada/${id}/itens`);
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/obras", async (req, res) => {
    try {
      const cached = await readFromFile("obras.json");
      if (cached) return res.json(cached);

      const response = await siengeAPI.get(`${detectedPrefix}/obras`);
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/usuarios", async (req, res) => {
    try {
      const cached = await readFromFile("usuarios.json");
      if (cached) return res.json(cached);

      const response = await siengeAPI.get(`${detectedPrefix}/usuarios`);
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/credores", async (req, res) => {
    try {
      const cached = await readFromFile("credores.json");
      if (cached) return res.json(cached);

      const response = await siengeAPI.get(`${detectedPrefix}/credores`);
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/companies", async (req, res) => {
    try {
      const cached = await readFromFile("empresas.json");
      if (cached) return res.json(cached);

      const response = await siengeAPI.get(`${detectedPrefix}/companies`);
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/clientes", async (req, res) => {
    try {
      const cached = await readFromFile("clientes.json");
      if (cached) return res.json(cached);

      const response = await siengeAPI.get(`${detectedPrefix}/clientes`);
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/pedidos-compra", async (req, res) => {
    try {
      const cached = await readFromFile("pedidos.json");
      if (cached && !req.query.force) return res.json(cached);

      const response = await siengeAPI.get(`${detectedPrefix}/pedidos-compra`, { params: req.query });
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/pedidos-compra/:id/itens", async (req, res) => {
    try {
      const { id } = req.params;
      
      // Tentar buscar do cache de itens consolidado
      const cachedItems = await readFromFile("itens_pedidos.json");
      if (cachedItems && cachedItems[id]) {
        return res.json(cachedItems[id]);
      }

      const response = await siengeAPI.get(`${detectedPrefix}/pedidos-compra/${id}/itens`);
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  app.get("/api/sienge/extrato", async (req, res) => {
    try {
      const response = await siengeAPI.get(`${detectedPrefix}/extratos-bancarios`, { params: req.query });
      res.json(response.data);
    } catch (error: any) {
      res.status(error.response?.status || 500).json(error.response?.data || error.message);
    }
  });

  // --- CONFIGURAÇÃO VITE / FRONTEND ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`
    ✅ Servidor rodando!
    🚀 Local: http://localhost:${PORT}
    🔗 API Sienge: ${SIENGE_BASE_URL}
    ⚙️ Atualização Automática: ON (A cada 20 min)
    `);

    // Inicia um primeiro pre-cache isolado sem bloquear boot do server
    setTimeout(() => {
      syncAllData().catch(e => console.log(e));
    }, 5000);

    // Sistema autonomo de background do servidor
    setInterval(() => {
      syncAllData().catch(e => console.log(e));
    }, 20 * 60 * 1000);
  });
}

startServer();