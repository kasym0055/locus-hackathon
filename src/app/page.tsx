export default function Home() {
  return (
    <main>
      <p>Visual University Profile</p>
      <h1>Find a university worth seeing.</h1>
      <form action="#" role="search">
        <label htmlFor="university-query">Search universities</label>
        <input id="university-query" name="query" placeholder="Try a university name" type="search" />
        <button type="submit">Search</button>
      </form>
    </main>
  );
}
