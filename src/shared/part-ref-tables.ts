/** Tabelas de lookup usadas no Gerador de Referências (replicadas do .xlsx). */

export const FORNECEDORES: Record<string, string> = {
  "PARCELL": "P",
  "PK MOBILE": "PK",
  "SKYTECH": "S",
  "MERCADO LIVRE": "ML",
  "JF DISTRIBUIDORA": "JF",
  "QUALITY": "QL",
  "SMART PARTS": "SP",
  "QUARTT": "Q",
  "OUTROS": "O",
  "SLIM PARTS": "SLP",
  "UP&HELP": "UH",
  "GOLDEN CELL": "GC",
  "SKAIKY": "SK",
  "ITECH": "IT",
};

export const MARCAS: Record<string, string> = {
  "SAMSUNG": "S",
  "MOTOROLA": "M",
  "LG": "L",
  "ASUS": "A",
  "XIAOMI": "X",
  "NOKIA": "N",
  "POSITIVO": "P",
  "APPLE": "A",
};

export const MODELOS: Record<string, number> = {
  "M12": 1, "A71": 2, "A02S": 3, "G6 PLUS": 4, "G9 PLAY": 5, "G7 PLAY": 6,
  "E5 PLUS": 7, "G6 PRETO": 8, "E7 PLUS": 9, "G20": 10, "G9 POWER": 11,
  "ONE VISION": 12, "G8 PLUS": 13, "A10": 14, "A21S": 15, "A50": 16,
  "A03 CORE": 17, "A31": 18, "A13 4G": 19, "A20": 20, "A30S": 21,
  "E6": 22, "G 5G": 23, "G7": 24, "ONE ACTION": 25, "G31": 26,
  "E7": 27, "G30": 28, "G10": 29, "G52": 30, "ONE": 31, "8": 32,
  "MI 9T": 33, "NOTE 10 LITE": 34, "NOTE 8 PRO": 35, "MI SE": 36,
  "K11": 37, "NOTE 7": 38, "K12 PRIME": 39, "K50S": 40, "A11": 41,
  "K12 MAX": 42, "K52": 43, "A32 5G": 44, "M20": 45, "A03S": 46,
  "M31": 47, "A20S": 48, "A12": 49, "A70": 50, "S21 PLUS": 51,
  "A30": 52, "S20 FE": 53, "S10": 54, "S20": 55, "A51": 56,
  "S10 PLUS": 57, "A80": 58, "S21": 59, "ONE FUSION": 60, "G6 PLAY": 61,
  "G8 PLAY": 62, "ONE ZOOM": 63, "E6 PLUS": 64, "G9 PLUS": 65, "E6I": 66,
  "E6S": 67, "S2": 68, "NOTE 9": 69, "POCOPHONE F1": 70, "MI 9": 71,
  "SE (2A GERACAO)": 72, "11": 73, "6 PLUS": 74, "P35": 75, "A52": 76,
  "NOTE 20": 77, "S21 FE": 78, "M30": 79, "POCOPHONE M3": 80, "ZENFONE 5": 81,
  "MI A2 LITE": 82, "MAX SHOT": 83, "LIVE L1": 84, "MI A1": 85, "6S": 86,
  "6S PLUS": 87, "7 PLUS": 88, "X": 89, "8 PLUS": 90, "XS MAX": 91,
  "XR": 92, "A32": 93, "7": 94, "XS": 95, "13": 96, "6": 97,
  "EDGE 30 PRO": 98, "A10S": 99, "G200": 100, "G62": 101, "G60": 102,
  "G22": 103, "G8 POWER LITE": 104, "G53 5G": 105, "E6 PLAY": 106,
  "MI 5": 107, "NOTE 8": 108, "ZENFONE 6": 109, "MI A2": 110,
  "NOTE 9S": 111, "NOTE 6 PRO": 112, "K61": 113, "LG K41": 114,
  "LG K12": 115, "K51S": 116, "K41S": 117, "K11 PLUS": 118,
  "K22 PLUS": 119, "K22": 120, "K40": 121, "K41": 122, "K12 PLUS": 123,
  "E7 POWER": 124, "ONE MACRO": 125, "MOTO G6": 126, "G8 POWER": 127,
  "G7 POWER": 128, "G7 PLUS": 129, "A01 CORE": 130, "A01": 131,
  "A22": 132, "M10": 133, "G71": 134, "POCOPHONE X3": 135, "NOTE 8T": 136,
  "MI 8 LITE": 137, "7 PRO": 138, "E20": 139, "12 MINI": 140,
  "12 PRO MAX": 141, "12": 142, "11 PRO": 143, "13 MINI": 144,
  "11 PRO MAX": 145, "14 PRO MAX": 146, "ONE HYPER": 147, "S20 ULTRA": 148,
  "G32": 149, "12 PRO": 150, "G23": 151, "12/12 PRO": 152,
  "A22 5G": 153, "A14 5G": 154, "A04E": 155, "A02": 156, "A33 5G": 157,
  "SE (3A GERACAO)": 158, "A14 4G": 159, "G8": 160,
  "A50/A30/A30S/A20": 161, "A10S/A20S": 162, "S22": 163,
  "A52/A52S 5G/S20 FE": 164, "A03": 165, "K40S": 166,
  "A31/A22 4G/A22 5G/A32 4G": 167, "A73": 168,
  "A02S/A03/A03S/A03 CORE/A04": 169, "A10S/A20S/A11/A21": 170,
  "ONE VISION/ONE ACTION": 171, "E22": 172, "G50 5G": 173,
  "A20S/A30S/A40S/A50S": 174, "E40": 175, "G60S": 176, "A23 4G": 177,
  "M21S": 178, "G10/G20/G30": 179, "M62": 180, "Z FLIP 3": 181,
  "M22": 182, "M53": 183, "M23": 184, "K12/K12 PLUS": 185, "A72": 186,
  "G 5G PLUS": 187, "M52 5G": 188, "G7/G7 PLUS": 189, "A73 5G": 190,
  "A02/A12/A21S/A13 4G": 191, "13 PRO MAX": 192, "A13 4G/M13 4G": 193,
  "A52 5G/A52S 5G": 194, "E20/E30/E40": 195, "EDGE 20": 196, "A54": 197,
  "ZENFONE MAX PRO (M2)": 198, "M53 5G": 199, "G73 5G": 200,
  "K61S": 201, "REDMI NOTE 8": 202, "XS ": 203, "G73": 204,
  "G7 PLAY/ONE": 205, "A11/A10S/A20S": 206,
  "A20/A30/A30S/A40/A50/A50S/A60/A70/A70S": 207, "G23/G13": 208,
  "A13": 209, "A32 4G": 210, "EDGE 30 NEO": 211, "S21 ULTRA": 212,
  "A34": 213, "M23 5G/M33 5G": 214, "G9/G9 PLAY": 215,
  "EDGE 20 LITE": 216, "A10/A20/A30/A50/A21/A21S": 217,
  "G8 PLAY/ONE MACRO": 218, "A03/A03S/A02S/A03 CORE": 219, "A53 5G": 220,
  "G10/G10 POWER": 221, "A20/A30": 222, "ZENFONE MAX PRO": 223,
  "S10 LITE": 224, "K62": 225, "G200 5G": 226, "ZENFONE MAX PRO (M1)": 227,
  "M23 5G": 228, "NOTE 20 ULTRA": 229, "EDGE 30": 230, "M21/M30S": 231,
  "EDGE 30 5G": 232, "EDGE 30 ULTRA": 233, "M30S": 234, "M51": 235,
  "K62/K62 PLUS": 236, "E13": 237, "G14": 238, "13 PRO": 239,
  "A02S/A037/A03S": 240, "G9 PLAY/G8 POWER LITE/G7 POWER/G30/G20/G10/G32/E7 PLUS/E7 POWER/E40/ONE FUSION": 241,
  "A15 4G": 242, "S20 PLUS": 243, "MOTO E13/E32/G53/G22/G13": 244,
  "S22 PLUS": 245, "14 PRO": 246, "G84 5G": 247, "A52S": 248,
  "M31/M30/M21S": 249, "A23 5G": 250, "5.4": 251, "A22 4G": 252,
  "MI A3/MI 9 LITE": 253, "MI 9T/9T": 254, "A04S": 255, "5C": 256,
  "XS/XS MAX": 257, "S23 PLUS": 258, "S23 FE": 259, "G100": 260,
  "G PLUS": 261, "EDGE 30 PRO 5G": 262, "A23": 263, "REDMI 8": 264,
  "M3/9T/9": 265, "K12": 266, "K41 PLUS": 267, "A24": 268, "G41": 269,
  "A05S": 270, "K8": 271, "ONE FUSION PLUS": 272, "IPAD AIR/IPAD 5": 273,
  "K8 PLUS": 274, "EDGE 20 PRO": 275, "MAX SHOT PLUS": 276,
  "IPAD AIR 2/IPAD 6": 277, "G82": 278, "KL/PRO M2": 279, "A05": 280,
  "A24 5G": 281, "A34 5G": 282, "A52S 5G": 283, "M32": 284,
  "A14": 285, "G54": 286, "E32": 287, "EDGE": 288, "EDGE PLUS": 299,
  "14 PLUS": 300, "A15 5G": 301, "G24": 302, "ZENFONE 4": 303,
  "S10E": 304, "G34": 305, "A52 4G": 306, "M15": 307, "G42": 308,
  "A54 5G": 309, "A04": 310, "15 PRO MAX": 311, "EDGE 40": 312,
  "K9": 313, "EDGE 40 NEO": 314, "G04": 315, "G62 5G": 316,
  "S22 ULTRA": 317, "M21": 318, "EDGE PRO": 319, "EDGE 20 (320)": 320,
  "IPAD 5": 321, "S24 ULTRA": 322, "G35": 323, "M34": 324, "A25": 325,
  "A55": 326, "A35": 327, "14": 328, "M54": 329, "M14": 330,
  "EDGE 50 PRO": 331, "A06": 332, "15 PLUS": 333, "M13": 334,
  "S24 FE": 335, "EDGE 30 FUSION": 336, "A25 5G": 337, "G13": 338,
  "EDGE 50 FUSION": 339, "A16": 340, "S23": 341, "RAZR 40": 342,
  "S24": 343, "M52 5G (344)": 344, "S24 PLUS": 345, "EDGE 60 FUSION": 346,
  "M55": 347, "15 (348)": 348, "LINHA A": 349, "S23 ULTRA": 350,
  "15 PRO": 351, "A07": 352, "A15": 353, "A51/A51S": 354,
  "G05": 355, "14/14 PLUS": 356,
};

export const CORES: Record<string, number> = {
  "AZUL": 1, "VERDE": 2, "DOURADO": 3, "PRETO": 4, "BRONZE": 5,
  "AZUL SAFIRA": 6, "BRANCO": 7, "CINZA": 8, "VERMELHO": 9, "PRATA": 10,
  "ROSA": 11, "VIOLETA": 12, "LAVANDA": 13, "VERMELHO CEREJA": 14,
  "AQUAMARINE": 15, "GRAFITE": 16, "ROXO": 17, "AZUL CLARO": 18,
  "AZUL TURQUESA": 19, "LARANJA": 20, "DARK PRISM": 21, "CINZA TITANIO": 22,
  "CORAL": 23, "AZUL AQUA": 24, "INDIGO": 25, "WHITE LILAC": 26,
  "CHAMPAGNHE": 27, "MARROM": 28, "LÍLAS": 29, "AZUL NAVY": 30,
  "COBRE": 31, "ROSE": 32,
};

export const PECAS: Record<string, number> = {
  "TAMPA TRASEIRA": 1, "FRONTAL COM ARO": 2, "GAVETA DE CHIP": 3,
  "REAR LATERAL": 4, "FRONTAL": 5, "CAMERA TRASEIRA": 6, "BATERIA": 7,
  "CARCAÇA": 8, "CARCAÇA S/ARO": 9, "MOTOR VIBRA": 10, "FLEX POWER": 11,
  "ALTO FALANTE": 12, "EARPIECE": 13, "CAMERA FRONTAL": 14, "FLEX DOCK": 15,
  "BOTÃO HOME": 16, "BOTÃO POWER": 17, "FLEX VOLUME": 18,
  "LENTE DA CAMERA TRASEIRA": 19, "ANTENA DE WIFI": 20,
  "LEITOR BIOMETRICO": 21, "FLEX PRINCIPAL": 22, "SENSOR DE PROXIMIDADE": 23,
  "FLEX SENSOR AURICULAR": 24, "CARCAÇA SEM FLEX": 25,
  "BACK COM LENTES DAS CAMERAS TRASEIRAS": 26, "SENSOR BIOMÉTRICO": 27,
  "MOLDURA": 28, "BACK SEM LENTES DAS CAMERAS TRASEIRAS": 29,
  "CHASSI": 30, "KIT TAMPA E REAR LATERAL": 31, "CARCAÇA E REAR LATERAL": 32,
  "FLEX OCTA": 33, "KIT DE FLEX POWER E VOLUME": 34, "PLACA MÃE": 35,
  "PLACA SUB": 36, "BATERIA DECODE": 37, "FLEX BIOMETRIA": 38, "S-PEN": 39,
};

// Tabelas inversas (número → nome)
export const FORNECEDOR_BY_LETRA: Record<string, string[]> = Object.entries(FORNECEDORES)
  .reduce((acc, [nome, letra]) => {
    if (!acc[letra]) acc[letra] = [];
    acc[letra].push(nome);
    return acc;
  }, {} as Record<string, string[]>);

export const MARCA_BY_LETRA: Record<string, string[]> = Object.entries(MARCAS)
  .reduce((acc, [nome, letra]) => {
    if (!acc[letra]) acc[letra] = [];
    acc[letra].push(nome);
    return acc;
  }, {} as Record<string, string[]>);

export const MODELO_BY_NUM: Record<number, string[]> = Object.entries(MODELOS)
  .reduce((acc, [nome, num]) => {
    if (!acc[num]) acc[num] = [];
    acc[num].push(nome);
    return acc;
  }, {} as Record<number, string[]>);

export const COR_BY_NUM: Record<number, string> = Object.fromEntries(
  Object.entries(CORES).map(([nome, num]) => [num, nome]),
);

export const PECA_BY_NUM: Record<number, string> = Object.fromEntries(
  Object.entries(PECAS).map(([nome, num]) => [num, nome]),
);

export const PREFIX = "PC";

/** Gera referência a partir dos componentes. */
export function generateReference(params: {
  fornecedor: string;
  marca: string;
  modelo: string;
  cor: string;
  peca: string;
}): string | null {
  const fLetra = FORNECEDORES[params.fornecedor.toUpperCase()];
  const mLetra = MARCAS[params.marca.toUpperCase()];
  const modeloNum = MODELOS[params.modelo.toUpperCase()];
  const corNum = CORES[params.cor.toUpperCase()];
  const pecaNum = PECAS[params.peca.toUpperCase()];
  if (!fLetra || !mLetra || modeloNum === undefined || corNum === undefined || pecaNum === undefined) return null;
  return `${PREFIX}-${fLetra}${mLetra}${modeloNum}${corNum}${pecaNum}`;
}

export interface DecodedReference {
  fornecedores: string[];
  marcas: string[];
  modelos: string[];
  cor: string | null;
  peca: string | null;
  raw: string;
}

/** Tenta decodificar uma referência PC-... para os componentes originais. */
export function decodeReference(ref: string): DecodedReference | null {
  const upper = ref.trim().toUpperCase();
  if (!upper.startsWith(PREFIX + "-")) return null;
  const rest = upper.slice(PREFIX.length + 1); // e.g. "PA7347"

  // Tentar todos os prefixos de fornecedor (mais longos primeiro)
  const sortedFornLetras = Object.values(FORNECEDORES)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => b.length - a.length);

  for (const fLetra of sortedFornLetras) {
    if (!rest.startsWith(fLetra)) continue;
    const afterF = rest.slice(fLetra.length); // e.g. "A7347"
    if (!afterF) continue;

    // Próximo char é marca
    const mLetra = afterF[0];
    const digits = afterF.slice(1); // e.g. "7347"
    if (!digits || !/^\d+$/.test(digits)) continue;

    const fornecedores = FORNECEDOR_BY_LETRA[fLetra] ?? [];
    const marcas = MARCA_BY_LETRA[mLetra] ?? [];
    if (!fornecedores.length || !marcas.length) continue;

    // Tentar todas as combinações de comprimento para modelo+cor+peça
    const len = digits.length;
    const results: Array<{ modelos: string[]; cor: string; peca: string }> = [];

    for (let pecaLen = 1; pecaLen <= 2; pecaLen++) {
      if (pecaLen >= len) continue;
      const pecaNum = parseInt(digits.slice(-pecaLen), 10);
      const peca = PECA_BY_NUM[pecaNum];
      if (!peca) continue;
      const remaining = digits.slice(0, -pecaLen);

      for (let corLen = 1; corLen <= 2; corLen++) {
        if (corLen >= remaining.length) continue;
        const corNum = parseInt(remaining.slice(-corLen), 10);
        const cor = COR_BY_NUM[corNum];
        if (!cor) continue;
        const modelDigits = remaining.slice(0, -corLen);
        if (!modelDigits) continue;
        const modeloNum = parseInt(modelDigits, 10);
        const modelos = MODELO_BY_NUM[modeloNum] ?? [];
        if (!modelos.length) continue;
        results.push({ modelos, cor, peca });
      }
    }

    if (results.length > 0) {
      // Prefer the result with fewest possible modelos (most specific decode)
      results.sort((a, b) => a.modelos.length - b.modelos.length);
      return {
        fornecedores,
        marcas,
        modelos: results[0].modelos,
        cor: results[0].cor,
        peca: results[0].peca,
        raw: ref,
      };
    }
  }

  return null;
}
