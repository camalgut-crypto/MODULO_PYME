-- Cartera del equipo PYME (Nicaragua). Se ejecuta en SRV-BIJAGUA\RIESGO.
-- El proceso reemplaza /*EQUIPO*/ por las cédulas de los promotores activos del administrador de personal
-- (validadas: solo letras y números). Para probarlo a mano, poner las cédulas entre comillas separadas por coma.
--
-- Llave: en el loan, credito = 'JAR 50131' (comprobante + espacio + numero). En CENDOC y MCCOLLECT viene igual
-- (CENDOC con espacios al final) y en CHIRICO está en tipo_doc + numero_doc. En la salida va con guion bajo: JAR_50131.
-- Primero se arma la cartera del equipo (#base) y cada fuente se filtra contra ella: así el tiempo depende del tamaño
-- del equipo y no del de toda la cartera del país.
SET NOCOUNT ON;

DECLARE @f_lt date = (SELECT MAX(f_reporte) FROM [LOAN_TAPE].[dbo].[loantape_his_ni]);
DECLARE @f_cd date = (SELECT MAX(f_reporte) FROM [CENDOC].[dbo].[th_cendoc_diario_regional] WHERE pais = 'NICARAGUA');
DECLARE @f_mc date = (SELECT MAX(f_reporte) FROM [MCCOLLECT].[dbo].[th_mccollect_cartera_diaria_regional] WHERE pais = 'Nicaragua');
DECLARE @f_ch date = (SELECT MAX(f_reporte) FROM [CHIRICO].[dbo].[th_chirico_diario_regional] WHERE pais = 'Nicaragua');

-- 1. Créditos colocados por los promotores del equipo (colocación / bitácora)
SELECT RTRIM(Comprobante) AS comprobante, Consecutivo AS numero, RTRIM(Promotor) AS promotor,
       RTRIM(Cedula_Promotor) AS cedula_promotor, RTRIM(Cedula) AS cedula, Fecha_Formalizado
INTO #prom
FROM [SRV-TORTUGUERO\DATAWAREHOUSE].[GENESIS_REGIONAL].[dwh].[V_BIT_REGIONAL_COLOCACION_new]
WHERE IdPais = 2
  AND Consecutivo > 0
  AND Cedula_Promotor IN (/*EQUIPO*/);

-- 2. Cartera del equipo: loan tape del último corte (solo lo que trae el loan)
SELECT RTRIM(L.credito) AS credito_sql, RTRIM(L.comprobante) AS comprobante, L.numero,
       L.cedula, L.nombre_deudor, L.fecha_renov, L.nit,
       P.promotor, P.cedula_promotor, P.cedula AS cedula_colocacion
INTO #base
FROM [LOAN_TAPE].[dbo].[loantape_his_ni] L
INNER JOIN (SELECT *, ROW_NUMBER() OVER (PARTITION BY comprobante, numero ORDER BY Fecha_Formalizado DESC) AS rn
            FROM #prom) P
        ON P.comprobante = RTRIM(L.comprobante) AND P.numero = L.numero AND P.rn = 1
WHERE L.f_reporte = @f_lt;
CREATE UNIQUE CLUSTERED INDEX ix_base ON #base (credito_sql);

-- 3. CENDOC (último corte)
SELECT RTRIM(C.dco_credito) AS credito_sql, C.dco_empresa, C.dco_cuotas_pagas, C.dco_dias_mora_hoy,
       ROW_NUMBER() OVER (PARTITION BY RTRIM(C.dco_credito) ORDER BY (SELECT NULL)) AS rn
INTO #cd
FROM [CENDOC].[dbo].[th_cendoc_diario_regional] C
WHERE C.pais = 'NICARAGUA' AND C.f_reporte = @f_cd
  AND RTRIM(C.dco_credito) IN (SELECT credito_sql FROM #base);

-- 4. MCCOLLECT (su propio último corte)
SELECT RTRIM(M.PR_MC_CREDITO) AS credito_sql, M.PR_CL_NRO_CUOTAS_VENCIDAS, M.PR_CL_MONTO_ULT_PAGARE,
       M.PR_CL_SALDO_DOC, M.PR_CL_DIA_MORA_HOY, M.PR_CL_VALOR_VENCIDO,
       ROW_NUMBER() OVER (PARTITION BY RTRIM(M.PR_MC_CREDITO) ORDER BY (SELECT NULL)) AS rn
INTO #mc
FROM [MCCOLLECT].[dbo].[th_mccollect_cartera_diaria_regional] M
WHERE M.pais = 'Nicaragua' AND M.f_reporte = @f_mc
  AND RTRIM(M.PR_MC_CREDITO) IN (SELECT credito_sql FROM #base);

-- 5. Pagos de clientes en CHIRICO. Cada pago se repite en cada f_reporte: se deja una sola versión
--    (la del corte más reciente) y se suma lo pagado desde el desembolso.
SELECT B.credito_sql, H.fecha, H.pago, H.interes, H.mora, H.ocargos, H.capital, B.fecha_renov,
       ROW_NUMBER() OVER (PARTITION BY H.comprobante, H.tipo_doc, H.numero_doc, H.numero, H.fecha, H.monto
                          ORDER BY H.f_reporte DESC, H.f_carga DESC) AS rn
INTO #pag_raw
FROM [CHIRICO].[dbo].[th_chirico_diario_regional] H
INNER JOIN #base B ON B.comprobante = RTRIM(H.tipo_doc) AND B.numero = H.numero_doc
WHERE H.clasi_comprob_origen = 'Clientes'
  AND H.pais = 'Nicaragua';

SELECT credito_sql,
       SUM(pago) AS total_pagado, SUM(interes) AS total_interes, SUM(mora) AS total_mora,
       SUM(ocargos) AS total_ocargos, SUM(capital) AS total_capital
INTO #pag
FROM #pag_raw
WHERE rn = 1 AND fecha >= fecha_renov
GROUP BY credito_sql;

-- 6. Teléfonos y direcciones del cliente
SELECT D.nit, RTRIM(D.tel1) AS tel1, RTRIM(D.tel2) AS tel2, RTRIM(D.dir1) AS dir1, RTRIM(D.dir2) AS dir2,
       ROW_NUMBER() OVER (PARTITION BY D.nit ORDER BY (SELECT NULL)) AS rn
INTO #dc
FROM [SRV-TORTUGUERO\DATAWAREHOUSE].[CARTERA_REGIONAL].[DocDeu].[Dim_Cliente] D
WHERE D.pais = 2;

-- 7. Resultado
SELECT
    REPLACE(B.credito_sql, ' ', '_')            AS llave,
    B.cedula_promotor,
    B.promotor,
    COALESCE(NULLIF(RTRIM(B.cedula), ''), NULLIF(B.cedula_colocacion, '')) AS cedula,  -- vacía en el loan: colocación
    RTRIM(B.nombre_deudor)                      AS nombre_cliente,
    RTRIM(CD.dco_empresa)                       AS empresa_genesis,
    MC.PR_CL_NRO_CUOTAS_VENCIDAS                AS cuotas_mora,
    MC.PR_CL_VALOR_VENCIDO                      AS monto_cuota_mora,
    CD.dco_cuotas_pagas                         AS cuotas_pagadas,
    MC.PR_CL_DIA_MORA_HOY                       AS dias_mora_mc,
    B.fecha_renov                               AS fecha_desembolso,
    PG.total_pagado, PG.total_interes, PG.total_mora, PG.total_ocargos, PG.total_capital,
    CD.dco_dias_mora_hoy                        AS dias_mora,
    1 - MC.PR_CL_SALDO_DOC / NULLIF(MC.PR_CL_MONTO_ULT_PAGARE, 0) AS pct_amortizado,
    DC.tel1 AS tel_domicilio, DC.tel2 AS tel_negocio, DC.dir1 AS dir_domicilio, DC.dir2 AS dir_negocio,
    MC.PR_CL_MONTO_ULT_PAGARE                   AS saldopagare,
    MC.PR_CL_SALDO_DOC                          AS saldo,
    B.nit,
    @f_lt AS f_loan_tape, @f_cd AS f_cendoc, @f_mc AS f_mccollect, @f_ch AS f_chirico
FROM #base B
LEFT JOIN #cd CD ON CD.credito_sql = B.credito_sql AND CD.rn = 1
LEFT JOIN #mc MC ON MC.credito_sql = B.credito_sql AND MC.rn = 1
LEFT JOIN #pag PG ON PG.credito_sql = B.credito_sql
LEFT JOIN #dc DC ON DC.nit = B.nit AND DC.rn = 1
ORDER BY B.promotor, B.credito_sql;
