/*
 * Configuração da conexão com o Supabase.
 *
 * Preencha com os dados do projeto (Supabase → Project Settings → API):
 *   url   = "Project URL"           (ex.: https://abcdefgh.supabase.co)
 *   chave = chave PÚBLICA: "anon public" ou "publishable" (sb_publishable_...)
 *
 * NUNCA coloque aqui a chave "service_role" / "secret" (sb_secret_...): ela ignora o RLS
 * e daria acesso total ao banco a qualquer pessoa que abrir o site. O site recusa essa chave.
 *
 * Com url/chave vazios, o site apenas avisa que a conexão não está configurada.
 */
(function (A) {
  'use strict';
  A.config = A.config || {
    url: 'https://ixrwnrwdsasuerjwidgj.supabase.co',
    chave: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4cnducndkc2FzdWVyandpZGdqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzMjM3NjEsImV4cCI6MjEwMTg5OTc2MX0.JTdoiZfOa6wK-CfjPLMMRyY0Bzsas1kkhmQ8KVRftSs',
  };
})(window.Agenda = window.Agenda || {});
