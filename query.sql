-- Poka Yoke Sorting SMG1: erros de hoje com gaiola, saca, substatus e qtd de bipes (horário de Brasília)
-- Este arquivo é lido pelo painel (api.js). Edite aqui e suba no GitHub para mudar a consulta.
WITH base AS (
  SELECT
    p.*,
    COUNTIF(EVENT_TYPE = 'CONTAINER_MISMATCH') OVER (
      PARTITION BY OPERATOR_ID, SHIPMENT_ID
      ORDER BY EVENT_DATE
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS mismatch_antes,
    COUNT(*) OVER (PARTITION BY OPERATOR_ID, SHIPMENT_ID) AS qtd_bipes
  FROM `meli-bi-data.WHOWNER.LK_SHIPPING_SORTING_POKAYOKE` p
  WHERE FACILITY_ID = 'SMG1'
    AND EVENT_DATE >= DATETIME(TIMESTAMP(CURRENT_DATE('America/Sao_Paulo'), 'America/Sao_Paulo'))
),
gaiolas AS (
  SELECT CAST(CONTAINER_ID AS INT64) AS id, ASSIGNMENT
  FROM `meli-bi-data.WHOWNER.LK_SHP_CONTAINER_PI_FEED`
  WHERE FACILITY_ID = 'SMG1'
    AND CHILD_CONTAINER_ID = 0
    AND ASSIGNMENT IS NOT NULL
    AND EVENT_DATE >= DATETIME_SUB(CURRENT_DATETIME(), INTERVAL 30 DAY)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY CONTAINER_ID ORDER BY EVENT_DATE DESC) = 1
),
sacas AS (
  SELECT
    CAST(SHP_LG_CC_CHILD_CONTAINER AS INT64) AS saca_id,
    SHP_SORTING_HIST_ASSIGNAMENT             AS saca,
    CAST(SHP_LG_CC_CONTAINER_ID AS INT64)    AS gaiola_pai_id
  FROM `meli-bi-data.WHOWNER.LK_SHP_LG_SORTING_HISTORY`
  WHERE SHP_LG_FACILITY_ID = 'SMG1'
    AND AUD_INS_DT >= DATE_SUB(CURRENT_DATE('America/Sao_Paulo'), INTERVAL 1 DAY)
    AND SHP_LG_CC_CONTAINER_TYPE = 'bag'
    AND SHP_LG_CC_CHILD_CONTAINER <> 0
    AND SHP_SORTING_HIST_ASSIGNAMENT IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY SHP_LG_CC_CHILD_CONTAINER ORDER BY SHP_LG_CC_DATE_CREATED DESC) = 1
),
chk AS (
  SELECT
    CAST(SHP_SHIPMENT_ID AS INT64)                        AS shp,
    NULLIF(SHP_LG_SUB_STATUS, '')                         AS substatus_chk,
    DATETIME_ADD(SHP_LG_SHIPMENT_CHK_DT, INTERVAL 1 HOUR) AS chk_dt_brt
  FROM `meli-bi-data.WHOWNER.BT_SHP_LG_SHIPMENT_CHECKPOINTS`
  WHERE SHP_LG_SHIPMENT_CHK_DT >= DATETIME_SUB(CURRENT_DATETIME('America/Sao_Paulo'), INTERVAL 2 DAY)
    AND SHP_LG_SHIPMENT_CHK_DT <= DATETIME_ADD(CURRENT_DATETIME('America/Sao_Paulo'), INTERVAL 1 DAY)
    AND CAST(SHP_SHIPMENT_ID AS INT64) IN (SELECT DISTINCT CAST(SHIPMENT_ID AS INT64) FROM base)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY SHP_SHIPMENT_ID ORDER BY SHP_LG_SHIPMENT_CHK_DT DESC, SHP_LG_SHIPMENT_CHECKPOINT_ID DESC) = 1
),
pk AS (
  SELECT
    CAST(SHIPMENT_ID AS INT64) AS shp,
    EVENT_TYPE                 AS ult_evento,
    DATETIME(TIMESTAMP(EVENT_DATE), 'America/Sao_Paulo') AS pk_dt_brt
  FROM base
  QUALIFY ROW_NUMBER() OVER (PARTITION BY SHIPMENT_ID ORDER BY EVENT_DATE DESC) = 1
),
status_atual AS (
  SELECT
    pk.shp,
    IF(chk.chk_dt_brt >= DATETIME_SUB(pk.pk_dt_brt, INTERVAL 5 SECOND), 'checkpoint', 'pokayoke') AS fonte_substatus,
    CASE
      WHEN chk.chk_dt_brt >= DATETIME_SUB(pk.pk_dt_brt, INTERVAL 5 SECOND) THEN chk.substatus_chk
      WHEN pk.ult_evento = 'SUCCESS' THEN 'in_container'
      ELSE 'sorting'
    END AS substatus
  FROM pk
  LEFT JOIN chk USING (shp)
)
SELECT
  FORMAT_DATETIME('%d/%m/%Y %H:%M:%S', DATETIME(TIMESTAMP(b.EVENT_DATE), 'America/Sao_Paulo')) AS data_hora,
  CAST(b.OPERATOR_ID AS INT64) AS user_id,
  u.USERNAME                   AS usuario,
  b.FACILITY_ID                AS svc,
  CAST(b.SHIPMENT_ID AS INT64) AS id_pacote,
  CASE b.EVENT_TYPE
    WHEN 'CONTAINER_MISMATCH' THEN 'Gaiola Errada'
    WHEN 'SHIPMENT_MISMATCH'  THEN 'Falha_PokaYoke'
    WHEN 'FORCE_EXIT'         THEN 'Forçou_Saída'
    WHEN 'QR_PROBLEM'         THEN IF(b.mismatch_antes > 0, 'Problema_QR', 'QR_Sem_PokaYoke')
  END AS erro,
  CAST(NULLIF(b.WRONG_CONTAINER_ID, 0) AS INT64) AS gaiola_bipada_id,
  COALESCE(gb.ASSIGNMENT, gbp.ASSIGNMENT, CAST(CAST(NULLIF(b.WRONG_CONTAINER_ID, 0) AS INT64) AS STRING)) AS gaiola_bipada,
  sb.saca AS saca_bipada,
  CAST(NULLIF(b.CONTAINER_ID, 0) AS INT64) AS gaiola_correta_id,
  COALESCE(gc.ASSIGNMENT, gcp.ASSIGNMENT, CAST(CAST(NULLIF(b.CONTAINER_ID, 0) AS INT64) AS STRING)) AS gaiola_correta,
  sc.saca AS saca_correta,
  CAST(NULLIF(b.WRONG_SHIPMENT_ID, 0) AS INT64) AS shp_bipado,
  CAST(b.SHIPMENT_ID AS INT64)                  AS shp_certo,
  CASE b.EXIT_REASON
    WHEN 'mislabeled'   THEN 'Etiqueta errada'
    WHEN 'wrong_island' THEN 'Pertence a outra rua'
    WHEN 'other'        THEN 'Outro'
    WHEN 'damaged'      THEN 'Avariado'
  END AS motivo_qr,
  sa.substatus,
  CASE sa.substatus
    WHEN 'in_container'     THEN 'No carrinho'
    WHEN 'sorting'          THEN 'Em separação'
    WHEN 'ready_to_deliver' THEN 'Pronto p/ entrega'
    WHEN 'buffered'         THEN 'Buffer'
    WHEN 'missorted'        THEN 'Separado errado'
    ELSE sa.substatus
  END AS substatus_pt,
  sa.fonte_substatus,
  b.qtd_bipes
FROM base b
LEFT JOIN `meli-bi-data.WHOWNER.LK_SHP_SHIPPING_USERS` u
  ON CAST(u.SHP_INTERNAL_USER_ID AS INT64) = CAST(b.OPERATOR_ID AS INT64)
LEFT JOIN gaiolas gb  ON gb.id = CAST(NULLIF(b.WRONG_CONTAINER_ID, 0) AS INT64)
LEFT JOIN sacas   sb  ON sb.saca_id = CAST(NULLIF(b.WRONG_CONTAINER_ID, 0) AS INT64)
LEFT JOIN gaiolas gbp ON gbp.id = sb.gaiola_pai_id
LEFT JOIN gaiolas gc  ON gc.id = CAST(NULLIF(b.CONTAINER_ID, 0) AS INT64)
LEFT JOIN sacas   sc  ON sc.saca_id = CAST(NULLIF(b.CONTAINER_ID, 0) AS INT64)
LEFT JOIN gaiolas gcp ON gcp.id = sc.gaiola_pai_id
LEFT JOIN status_atual sa ON sa.shp = CAST(b.SHIPMENT_ID AS INT64)
WHERE b.EVENT_TYPE != 'SUCCESS'
ORDER BY b.EVENT_DATE DESC
