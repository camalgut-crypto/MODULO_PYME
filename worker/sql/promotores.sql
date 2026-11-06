-- Catálogo de promotores de Nicaragua con colocaciones en los últimos 12 meses (para el administrador de personal).
-- Una fila por cédula, con el nombre y el tipo de su solicitud más reciente.
SET NOCOUNT ON;
SELECT cedula_promotor, promotor, tipo_promotor, ultima_solicitud, solicitudes
FROM (
    SELECT RTRIM(Cedula_Promotor) AS cedula_promotor,
           RTRIM(Promotor)        AS promotor,
           RTRIM(Tipo_Promotor)   AS tipo_promotor,
           CAST(MAX(Fecha_creacion) OVER (PARTITION BY RTRIM(Cedula_Promotor)) AS date) AS ultima_solicitud,
           COUNT(*) OVER (PARTITION BY RTRIM(Cedula_Promotor)) AS solicitudes,
           ROW_NUMBER() OVER (PARTITION BY RTRIM(Cedula_Promotor) ORDER BY Fecha_creacion DESC) AS rn
    FROM [SRV-TORTUGUERO\DATAWAREHOUSE].[GENESIS_REGIONAL].[dwh].[V_BIT_REGIONAL_COLOCACION_new]
    WHERE IdPais = 2
      AND Fecha_creacion >= DATEADD(month, -12, GETDATE())
      AND NULLIF(RTRIM(Cedula_Promotor), '') IS NOT NULL
) T
WHERE rn = 1
ORDER BY promotor;
